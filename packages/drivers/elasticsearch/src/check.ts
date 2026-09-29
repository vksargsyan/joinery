import { lookup as dnsLookup } from 'node:dns/promises';
import { connect as netConnect, isIP } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';

import {
  CONNECTION_CHECK_STEPS,
  ENGINES,
  JoineryError,
  type ConnectionCheckResult,
  type ConnectionCheckStep,
  type HostPort,
  type ResolvedProfile,
} from '@joinery/core';
import { errorMessage, type CheckConnectionDeps } from '@joinery/driver-sql-base';
import {
  distributionName,
  numberAt,
  parseJsonTree,
  searchCapabilities,
  stringAt,
} from '@joinery/search-tools';

import { parseRoot, readPlugins } from './cluster';
import { buildSearchClientPlan, hostPort, redactSecrets, type SearchClientPlan } from './config';
import { mapResponseError, mapTransportError, type SearchErrorContext } from './errors';
import { SearchHttpClient, type HttpRequest, type HttpResponse } from './http';

/**
 * Test Connection for Elasticsearch and OpenSearch (spec §4), in the core steps: DNS (every
 * node host), TCP (one reachable node is enough), the SSH tunnel or proxy, a TLS handshake
 * (https nodes), HTTP and authentication (`GET /`), ping (the cluster health) and the version
 * with the distribution, licence and cluster name. Each failing step names the problem and a
 * fix hint; the steps after it are skipped. Nothing reported holds a secret.
 */

/** The HTTP client the later steps use; injectable for tests. */
export interface SearchCheckClient {
  request(request: HttpRequest): Promise<HttpResponse>;
  close(): void;
}

export interface SearchCheckDeps extends CheckConnectionDeps {
  /** Completes a TLS handshake with `target` and closes it. */
  tlsHandshake(target: HostPort, options: ConnectionOptions, timeoutMs: number): Promise<void>;
  client(plan: SearchClientPlan): SearchCheckClient;
}

const defaultDeps: SearchCheckDeps = {
  async lookup(host) {
    const { address } = await dnsLookup(host);
    return address;
  },
  probe(target, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (target.kind !== 'tcp') {
        reject(new JoineryError({ code: 'NOT_SUPPORTED', message: 'A TCP endpoint is needed' }));
        return;
      }
      const socket = netConnect({ host: target.host, port: target.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      });
    });
  },
  now: () => performance.now(),
  tlsHandshake(target, options, timeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = tlsConnect({ ...options, host: target.host, port: target.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          Object.assign(new Error('TLS handshake timed out'), {
            code: 'ERR_TLS_HANDSHAKE_TIMEOUT',
          }),
        );
      }, timeoutMs);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        socket.end();
        socket.destroy();
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      });
    });
  },
  client: (plan) => new SearchHttpClient(plan),
};

class StepLog {
  private readonly reported = new Set<ConnectionCheckStep>();

  constructor(
    private readonly now: () => number,
    private readonly secrets: readonly string[],
  ) {}

  report(result: ConnectionCheckResult): ConnectionCheckResult {
    this.reported.add(result.step);
    return {
      ...result,
      ...(result.message !== undefined
        ? { message: redactSecrets(result.message, this.secrets) }
        : {}),
      ...(result.hint !== undefined ? { hint: redactSecrets(result.hint, this.secrets) } : {}),
    };
  }

  ok(step: ConnectionCheckStep, started: number, message?: string): ConnectionCheckResult {
    return this.report({
      step,
      status: 'ok',
      durationMs: Math.round(this.now() - started),
      ...(message !== undefined ? { message } : {}),
    });
  }

  skipped(step: ConnectionCheckStep, message: string): ConnectionCheckResult {
    return this.report({ step, status: 'skipped', durationMs: 0, message });
  }

  failure(step: ConnectionCheckStep, started: number, error: JoineryError): ConnectionCheckResult {
    return this.report({
      step,
      status: 'failed',
      durationMs: Math.round(this.now() - started),
      message: error.message,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
    });
  }

  *skipRest(): Generator<ConnectionCheckResult> {
    for (const step of CONNECTION_CHECK_STEPS) {
      if (!this.reported.has(step)) {
        yield {
          step,
          status: 'skipped',
          durationMs: 0,
          message: 'Not run: an earlier step failed',
        };
      }
    }
  }
}

function errorContextOf(plan: SearchClientPlan): SearchErrorContext {
  return {
    where: plan.where,
    secrets: plan.secrets,
    authMethod: plan.authMethod,
    ...(plan.user !== undefined ? { user: plan.user } : {}),
  };
}

function asJoinery(error: unknown, context: SearchErrorContext): JoineryError {
  return error instanceof JoineryError ? error : mapTransportError(error, context);
}

/** The stepwise Test Connection (see the module comment). */
export async function* checkSearchConnection(
  resolved: ResolvedProfile,
  deps: Partial<SearchCheckDeps> = {},
): AsyncGenerator<ConnectionCheckResult> {
  const d: SearchCheckDeps = { ...defaultDeps, ...deps };
  const { profile } = resolved;
  const secrets = Object.values(resolved.secrets);
  const log = new StepLog(d.now, secrets);
  const fallback: SearchErrorContext = { where: profile.name, secrets };

  if ((profile.ssh || profile.proxy) && !resolved.endpointOverride) {
    if (!d.runSshStep) {
      yield log.skipped('dns', 'The SSH server or proxy resolves the node host');
      yield log.skipped('tcp', 'Reached through the tunnel');
      yield log.report({
        step: 'ssh',
        status: 'failed',
        durationMs: 0,
        message: 'This profile uses an SSH tunnel or proxy, but no tunnel is open for it',
        hint: 'Tunnels are opened by the connection host; run Test Connection from the app',
      });
      yield* log.skipRest();
      return;
    }
    yield* throughTransport(resolved, d, log, d.runSshStep);
    return;
  }

  let started = d.now();
  let plan: SearchClientPlan;
  try {
    plan = buildSearchClientPlan(resolved);
  } catch (error) {
    yield log.failure('dns', started, asJoinery(error, fallback));
    yield* log.skipRest();
    return;
  }
  const context = errorContextOf(plan);

  // DNS: every node host name (IP addresses need none).
  const hosts = [
    ...new Set(
      plan.nodes.map((n) => n.hostHeader.replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1')),
    ),
  ];
  const names = hosts.filter((h) => isIP(h) === 0).slice(0, 8);
  if (resolved.endpointOverride) {
    yield log.skipped('dns', 'The SSH server or proxy resolves the node host');
  } else if (names.length === 0) {
    yield log.skipped('dns', `${hosts.join(', ')}: IP address${hosts.length > 1 ? 'es' : ''}`);
  } else {
    const results = await Promise.allSettled(names.map((h) => d.lookup(h)));
    const resolvedNames = names.filter((_, i) => results[i]!.status === 'fulfilled');
    if (resolvedNames.length === 0) {
      const first = results[0] as PromiseRejectedResult;
      yield log.failure('dns', started, asJoinery(first.reason, { ...context, where: names[0]! }));
      yield* log.skipRest();
      return;
    }
    const failed = names.filter((h) => !resolvedNames.includes(h));
    yield log.ok(
      'dns',
      started,
      `${names
        .map((h, i) =>
          results[i]!.status === 'fulfilled'
            ? `${h} → ${(results[i] as PromiseFulfilledResult<string>).value}`
            : undefined,
        )
        .filter((x) => x !== undefined)
        .join(', ')}${failed.length > 0 ? `; not resolved: ${failed.join(', ')}` : ''}`,
    );
  }

  // TCP: every node, in parallel; one reachable node is enough.
  started = d.now();
  const nodes = plan.nodes.slice(0, 8);
  const reached = await Promise.allSettled(
    nodes.map((n) =>
      d.probe({ kind: 'tcp', host: n.host, port: n.port, tlsHost: n.host }, plan.connectTimeoutMs),
    ),
  );
  const reachable = nodes.filter((_, i) => reached[i]!.status === 'fulfilled');
  if (reachable.length === 0) {
    const first = reached[0] as PromiseRejectedResult;
    yield log.failure(
      'tcp',
      started,
      asJoinery(first.reason, { ...context, where: hostPort(nodes[0]!.host, nodes[0]!.port) }),
    );
    yield* log.skipRest();
    return;
  }
  const unreachable = nodes.filter((n) => !reachable.includes(n));
  yield log.ok(
    'tcp',
    started,
    `Connected to ${reachable.map((n) => hostPort(n.host, n.port)).join(', ')}${
      unreachable.length > 0
        ? `; not reachable: ${unreachable.map((n) => hostPort(n.host, n.port)).join(', ')}`
        : ''
    }`,
  );

  if (resolved.endpointOverride) {
    yield log.ok(
      'ssh',
      d.now(),
      `Tunnel open at ${hostPort(resolved.endpointOverride.host, resolved.endpointOverride.port)}`,
    );
  } else {
    yield log.skipped('ssh', 'No SSH tunnel');
  }
  yield* httpSteps(resolved, plan, d, log);
}

/** TLS, HTTP and authentication, ping and version, against the plan's nodes. */
async function* httpSteps(
  resolved: ResolvedProfile,
  plan: SearchClientPlan,
  d: SearchCheckDeps,
  log: StepLog,
): AsyncGenerator<ConnectionCheckResult> {
  const context = errorContextOf(plan);
  const node = plan.nodes[0]!;
  let started = d.now();
  if (node.protocol === 'http:') {
    yield log.skipped('tls', 'The URL is http://: requests and credentials travel unencrypted');
  } else {
    try {
      await d.tlsHandshake(
        { host: node.host, port: node.port },
        node.tls ?? {},
        plan.connectTimeoutMs,
      );
      const mode = node.tlsSettings?.mode ?? 'verify-full';
      yield log.ok(
        'tls',
        started,
        mode === 'require'
          ? 'Encrypted; the server certificate is not verified'
          : mode === 'verify-ca'
            ? 'Encrypted; certificate chain verified (host name not checked)'
            : 'Encrypted; certificate and host name verified',
      );
    } catch (error) {
      const mapped = asJoinery(error, { ...context, where: node.label });
      // A plain HTTP port answers a TLS hello with text, or hangs up.
      const plainHttp =
        /wrong version number|packet length|unexpected eof|disconnected before|ECONNRESET|EPROTO/i.test(
          `${errorMessage(error)} ${mapped.message} ${String(mapped.engineCode ?? '')}`,
        );
      const failure =
        mapped.code === 'TLS_FAILED' && !plainHttp
          ? mapped
          : new JoineryError({
              code: 'TLS_FAILED',
              message: `TLS negotiation with ${node.label} failed: ${redactSecrets(errorMessage(error), plan.secrets)}`,
              hint: 'The node may not have TLS on its HTTP port: try an http:// URL, or check the TLS mode and certificates',
            });
      yield log.failure('tls', started, failure);
      yield* log.skipRest();
      return;
    }
  }

  const client = d.client(plan);
  try {
    // HTTP and authentication: GET / answers only an authenticated user.
    started = d.now();
    let response: HttpResponse;
    try {
      response = await client.request({ method: 'GET', path: '/' });
    } catch (error) {
      const mapped = asJoinery(error, context);
      yield log.failure(mapped.code === 'TLS_FAILED' ? 'tls' : 'auth', started, mapped);
      yield* log.skipRest();
      return;
    }
    let restricted = false;
    if (response.status === 403) {
      restricted = true;
    } else if (response.status !== 200) {
      yield log.failure('auth', started, mapResponseError(response.status, response.body, context));
      yield* log.skipRest();
      return;
    }
    let root: ReturnType<typeof parseRoot> | undefined;
    if (!restricted) {
      try {
        root = parseRoot(response.body, response.headers);
      } catch (error) {
        yield log.failure('auth', started, asJoinery(error, context));
        yield* log.skipRest();
        return;
      }
    }
    const who = await currentUser(client, plan);
    yield log.ok(
      'auth',
      started,
      restricted
        ? `${who ?? 'Signed in'}; this user may not read the cluster information (it needs the monitor privilege)`
        : (who ?? (plan.authMethod === 'none' ? 'No authentication needed' : 'Signed in')),
    );

    // Ping: the cluster health.
    started = d.now();
    try {
      const health = await client.request({ method: 'GET', path: '/_cluster/health' });
      if (health.status === 200) {
        const node = parseJsonTree(health.body);
        const status = stringAt(node, 'status') ?? 'unknown';
        const count = numberAt(node, 'number_of_nodes');
        yield log.ok(
          'ping',
          started,
          `Cluster health ${status}${count !== undefined ? `, ${count} node${count === 1 ? '' : 's'}` : ''}`,
        );
      } else if (health.status === 403) {
        yield log.ok(
          'ping',
          started,
          'The node answers (this user may not read the cluster health)',
        );
      } else {
        yield log.failure('ping', started, mapResponseError(health.status, health.body, context));
        yield* log.skipRest();
        return;
      }
    } catch (error) {
      yield log.failure('ping', started, asJoinery(error, context));
      yield* log.skipRest();
      return;
    }

    // Version, distribution and licence.
    started = d.now();
    if (!root) {
      yield log.ok('version', started, 'Unknown: the user may not read GET /');
      return;
    }
    const plugins = await readPlugins(client);
    const capabilities = searchCapabilities({
      distribution: root.distribution,
      version: root.version,
      ...(root.buildFlavor !== undefined ? { buildFlavor: root.buildFlavor } : {}),
      plugins,
    });
    const parts: string[] = [];
    if (root.distribution === 'elasticsearch') {
      if (root.buildFlavor === 'oss') parts.push('OSS distribution');
      const license = await client
        .request({ method: 'GET', path: '/_license' })
        .then((r) => (r.status === 200 ? parseJsonTree(r.body) : undefined))
        .catch(() => undefined);
      const type = stringAt(license, 'license', 'type');
      const status = stringAt(license, 'license', 'status');
      if (type) parts.push(`${type} licence${status && status !== 'active' ? ` (${status})` : ''}`);
    }
    if (capabilities.esql) parts.push('ES|QL');
    if (capabilities.sql) parts.push('SQL');
    const engine = resolved.profile.engine;
    const mismatch =
      engine !== root.distribution
        ? `; the connection is set up for ${ENGINES[engine].displayName}, choose ${distributionName(root.distribution)} to match`
        : '';
    yield log.ok(
      'version',
      started,
      `${distributionName(root.distribution)} ${root.version}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}, cluster "${root.clusterName}"${mismatch}`,
    );
  } finally {
    client.close();
  }
}

/** "Signed in as elastic (realm reserved)", when the server can say who the user is. */
async function currentUser(
  client: SearchCheckClient,
  plan: SearchClientPlan,
): Promise<string | undefined> {
  if (plan.authMethod === 'none') return undefined;
  try {
    const es = await client.request({ method: 'GET', path: '/_security/_authenticate' });
    if (es.status === 200) {
      const node = parseJsonTree(es.body);
      const user = stringAt(node, 'username');
      const realm = stringAt(node, 'authentication_realm', 'name');
      if (user) return `Signed in as ${user}${realm ? ` (realm ${realm})` : ''}`;
    }
    const os = await client.request({ method: 'GET', path: '/_plugins/_security/authinfo' });
    if (os.status === 200) {
      const user = stringAt(parseJsonTree(os.body), 'user_name');
      if (user) return `Signed in as ${user}`;
    }
  } catch {
    // Who the user is is a nicety; the step already passed.
  }
  return plan.user ? `Signed in as ${plan.user}` : undefined;
}

/** DNS and TCP to the proxy or first SSH hop, the `ssh` step, then the HTTP steps through it. */
async function* throughTransport(
  resolved: ResolvedProfile,
  d: SearchCheckDeps,
  log: StepLog,
  runSshStep: NonNullable<CheckConnectionDeps['runSshStep']>,
): AsyncGenerator<ConnectionCheckResult> {
  const { profile } = resolved;
  const secrets = Object.values(resolved.secrets);
  const first = profile.proxy ?? profile.ssh!.hops[0]!;
  const what = profile.proxy ? 'proxy' : 'SSH server';
  const where = hostPort(first.host, first.port);
  const context: SearchErrorContext = { where, secrets };
  let started = d.now();
  if (isIP(first.host) !== 0) {
    yield log.skipped('dns', `The ${what} ${first.host} is an IP address`);
  } else {
    try {
      const address = await d.lookup(first.host);
      yield log.ok('dns', started, `The ${what} ${first.host} resolves to ${address}`);
    } catch (error) {
      yield log.failure('dns', started, asJoinery(error, context));
      yield* log.skipRest();
      return;
    }
  }
  started = d.now();
  try {
    await d.probe(
      { kind: 'tcp', host: first.host, port: first.port, tlsHost: first.host },
      profile.options.connectTimeoutMs,
    );
    yield log.ok('tcp', started, `Connected to the ${what} ${where}`);
  } catch (error) {
    yield log.failure('tcp', started, asJoinery(error, context));
    yield* log.skipRest();
    return;
  }
  started = d.now();
  let outcome: Awaited<ReturnType<typeof runSshStep>>;
  try {
    outcome = await runSshStep(resolved);
  } catch (error) {
    yield log.failure('ssh', started, asJoinery(error, context));
    yield* log.skipRest();
    return;
  }
  const transport = outcome.transport;
  try {
    yield log.report(outcome.result);
    if (outcome.result.status === 'failed' || !transport) {
      yield* log.skipRest();
      return;
    }
    const { proxy: _proxy, ...direct } = profile;
    const through: ResolvedProfile = {
      ...resolved,
      profile: direct,
      endpointOverride: transport.endpointOverride,
    };
    let plan: SearchClientPlan;
    try {
      plan = buildSearchClientPlan(through);
    } catch (error) {
      yield log.failure('tls', d.now(), asJoinery(error, context));
      yield* log.skipRest();
      return;
    }
    yield* httpSteps(through, plan, d, log);
  } finally {
    await transport?.close().catch(() => undefined);
  }
}
