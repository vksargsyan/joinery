import { readFileSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';
import { resolve } from 'node:path';

import { JoineryError } from '@joinery/core';
import { isSearchSession, type SearchSession } from '@joinery/driver-elasticsearch';
import {
  classifyRequest,
  compactJson,
  distributionName,
  formatJson,
  parseConsole,
  parseSearchError,
  quoteJson,
  type RequestSafety,
  type SearchRequest,
  type SearchResponse,
} from '@joinery/search-tools';
import { connectThroughTransport, needsTransport, type TransportSession } from '@joinery/tunnel';

import type { QueryOptions } from './commands/query';
import { cancellable, closeQuietly, missingPasswordHint } from './connect';
import { CliError, EXIT, formatError, type ExitCode } from './errors';
import { engineOf } from './mongo';
import { formatDuration, targetFor, writeLine, type Runtime } from './runtime';
import {
  SEARCH_SCHEMES,
  isConnectionUri,
  resolvedProfile,
  withPassword,
  type Target,
} from './target';

/**
 * Elasticsearch and OpenSearch in joinery-cli (spec §11): `joinery query <target> -e 'GET
 * _cluster/health'` runs Kibana console text (a request line, then an optional JSON body, or
 * NDJSON lines for _bulk and _msearch; several requests run in order) and prints each response
 * body, pretty-printed with numbers exactly as the server sent them; the status and timing go
 * to stderr. `--format json` prints an array of `{request, status, body}` objects and `jsonl`
 * one per line. The write rules apply as in the app: a read-only target refuses requests that
 * can write, destructive ones (deleting indices or documents, closing indices, delete by query,
 * force merge...) ask or need --yes, and production targets ask before every write. A response
 * with an error status counts as a failed request (exit 2).
 */

/** True when the target is an http(s):// URL or a saved Elasticsearch / OpenSearch profile. */
export function isSearchTarget(runtime: Runtime, spec: string): boolean {
  if (isConnectionUri(spec)) {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(spec.trim())?.[1]?.toLowerCase() ?? '';
    return SEARCH_SCHEMES.has(scheme);
  }
  const engine = engineOf(runtime, spec);
  return engine === 'elasticsearch' || engine === 'opensearch';
}

/** One request of the input, ready to send. */
export interface PlannedSearchRequest {
  readonly request: SearchRequest;
  /** "GET /_cluster/health", for messages. */
  readonly label: string;
  /** 1-based line of the request line in the input. */
  readonly line: number;
  readonly safety: RequestSafety;
}

/** 1-based line and column of an offset. */
function position(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return `${line}:${offset - before.lastIndexOf('\n')}`;
}

/**
 * Parses console text into requests. Any problem (an unreadable body, text outside a request)
 * is an error naming its line and column, and nothing runs.
 */
export function planSearchRequests(text: string): PlannedSearchRequest[] {
  const parsed = parseConsole(text);
  if (parsed.issues.length > 0) {
    const [first] = parsed.issues;
    const more = parsed.issues.length - 1;
    throw new CliError(
      `${position(text, first!.start)}: ${first!.message}${more > 0 ? ` (and ${more} more ${more === 1 ? 'problem' : 'problems'})` : ''}`,
      {
        hint: 'Write each request as a method and path on its own line (GET /_cluster/health), then its JSON body, if any',
      },
    );
  }
  return parsed.requests.map((request) => {
    const wire: SearchRequest = {
      method: request.method,
      path: request.path,
      ...(request.query !== '' ? { query: request.query } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
      ...(request.bodyKind !== 'none' ? { bodyKind: request.bodyKind } : {}),
    };
    const safety = classifyRequest(wire);
    return { request: wire, label: safety.label, line: request.line + 1, safety };
  });
}

/** "200 OK", "404 Not Found". */
export function statusLine(status: number): string {
  const text = STATUS_CODES[status];
  return text ? `${status} ${text}` : String(status);
}

/** A response body as the default output prints it: indented JSON, or the text as sent. */
export function prettyBody(response: Pick<SearchResponse, 'body' | 'contentType'>): string {
  const body = response.body;
  if (body.trim() === '' || !/json/i.test(response.contentType)) return body.replace(/\n$/, '');
  try {
    return formatJson(body);
  } catch {
    return body.replace(/\n$/, '');
  }
}

/**
 * One response as a JSON object for `--format json` / `jsonl`: the body is embedded as the
 * server's JSON (tokens unchanged) or, when it is not JSON, as a string; null for HEAD.
 */
export function responseJson(planned: PlannedSearchRequest, response: SearchResponse): string {
  let body = 'null';
  if (response.body.trim() !== '') {
    try {
      body = /json/i.test(response.contentType)
        ? compactJson(response.body)
        : quoteJson(response.body);
    } catch {
      body = quoteJson(response.body);
    }
  }
  return `{"request":${quoteJson(planned.label)},"status":${response.status},"body":${body}}`;
}

function readInput(runtime: Runtime, options: QueryOptions): Promise<string> | string {
  if (options.execute !== undefined && options.file !== undefined) {
    throw new CliError('Pass either -e <requests> or -f <file>, not both');
  }
  if (options.execute !== undefined) return options.execute;
  if (options.file !== undefined && options.file !== '-') {
    try {
      return readFileSync(resolve(runtime.ctx.cwd, options.file), 'utf8');
    } catch (error) {
      throw new CliError(
        `Cannot read ${options.file}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`,
        { code: 'NOT_FOUND' },
      );
    }
  }
  if (runtime.ctx.stdin.isTTY) {
    throw new CliError('No requests to run', {
      hint: 'Pass -e "GET _cluster/health", -f <file>, or pipe console requests into stdin',
    });
  }
  return (async () => {
    let text = '';
    for await (const chunk of runtime.ctx.stdin) text += String(chunk);
    return text;
  })();
}

/** Asks (or checks --yes) before a request the write rules stop; throws when it may not run. */
async function checkRequest(
  runtime: Runtime,
  target: Target,
  planned: PlannedSearchRequest,
  index: number,
  options: QueryOptions,
  fromStdin: boolean,
): Promise<void> {
  const { safety } = planned;
  if (!safety.writes) return;
  if (target.policy.readOnly) {
    throw new CliError(
      `Request ${index} (${planned.label}) can write, but "${target.label}" is read-only`,
      {
        code: 'READ_ONLY',
        hint:
          target.readOnlySource === 'flag'
            ? 'Writes are refused because --read-only was given'
            : 'The profile is locked read-only; unlock it in the app or use another profile to write',
      },
    );
  }
  const production = target.policy.production;
  const asks =
    safety.destructive !== undefined || production || target.policy.confirmWrites === true;
  if (!asks || options.yes) return;
  const why =
    safety.destructive !== undefined
      ? `${planned.label} ${safety.destructive}`
      : production
        ? `it writes to the production connection "${target.label}"`
        : `"${target.label}" asks before every write`;
  const { prompter } = runtime.ctx;
  if (!prompter.interactive || fromStdin) {
    throw new CliError(`Request ${index} needs confirmation: ${why}`, {
      code: 'CONFIRMATION_REQUIRED',
      hint: 'Pass --yes to run it without asking, or run in a terminal to confirm it',
    });
  }
  runtime.reporter.print(`Request ${index} needs confirmation: ${why}`);
  if ((await prompter.confirm('Send it?')) !== 'yes') {
    throw new CliError(`Request ${index} was not confirmed`, { code: 'CONFIRMATION_REQUIRED' });
  }
}

/** Connects to a search target (through its tunnel), asking for a password once if refused. */
async function openSearch(
  runtime: Runtime,
  target: Target,
  options: QueryOptions,
): Promise<TransportSession & { readonly target: Target }> {
  const adapter = runtime.ctx.adapters(target.profile.engine);
  const open = (current: Target): Promise<TransportSession> =>
    needsTransport(current.profile)
      ? connectThroughTransport(
          adapter,
          resolvedProfile(current),
          runtime.tunnels.manager(options.tunnel),
        )
      : adapter
          .connect(resolvedProfile(current))
          .then((session) => ({ session, close: () => session.close() }));
  runtime.reporter.progress(`Connecting to ${target.label}…`, true);
  try {
    try {
      return { ...(await open(target)), target };
    } catch (error) {
      const refused = error instanceof JoineryError && error.code === 'AUTH_FAILED';
      if (!refused || target.passwordKnown) throw error;
      if (!runtime.ctx.prompter.interactive) {
        throw new CliError(error.message, {
          code: 'AUTH_FAILED',
          hint: missingPasswordHint(target),
          cause: error,
        });
      }
      const retry = withPassword(
        target,
        await runtime.ctx.prompter.secret(`Password for ${target.label}: `),
      );
      return { ...(await open(retry)), target: retry };
    }
  } finally {
    runtime.reporter.clearProgress();
  }
}

/** The error of a failed response, for stderr: type, reason and the underlying cause. */
function responseError(planned: PlannedSearchRequest, response: SearchResponse): CliError {
  const info = parseSearchError(response.body);
  const reason = info
    ? `${info.type ? `${info.type}: ` : ''}${info.reason}${info.causedBy && !info.reason.includes(info.causedBy) ? ` (${info.causedBy})` : ''}`
    : 'no error details in the response';
  return new CliError(`${planned.label} failed with ${statusLine(response.status)}: ${reason}`, {
    code: response.status === 401 ? 'AUTH_FAILED' : 'SQL_ERROR',
  });
}

/** `joinery query` on an Elasticsearch or OpenSearch target (see the module comment). */
export async function searchQueryCommand(
  runtime: Runtime,
  spec: string,
  options: QueryOptions,
): Promise<ExitCode> {
  if (options.format === 'csv' || options.format === 'tsv') {
    throw new CliError(`Responses print as JSON, not ${options.format.toUpperCase()}`, {
      code: 'NOT_SUPPORTED',
      hint: 'Leave --format out for the response bodies, or use --format json or jsonl',
    });
  }
  if (options.params.length > 0) {
    throw new CliError('Console requests take no parameters', {
      code: 'NOT_SUPPORTED',
      hint: 'Write the values into the request',
    });
  }
  const fromStdin =
    options.execute === undefined && (options.file === undefined || options.file === '-');
  const requests = planSearchRequests(await readInput(runtime, options));
  if (requests.length === 0) {
    runtime.reporter.info('No requests to run');
    return EXIT.ok;
  }
  const target = await targetFor(runtime, spec, options);
  runtime.interrupts.throwIfInterrupted();
  const connection = await openSearch(runtime, target, options);
  const { session } = connection;
  const { reporter } = runtime;
  let failures = 0;
  let firstJson = true;
  try {
    if (!isSearchSession(session)) {
      throw new CliError(`"${target.label}" is not an Elasticsearch or OpenSearch server`);
    }
    reporter.debug(
      `connected to ${connection.target.label}: ${distributionName(session.distribution)} ${session.serverVersion || '(version hidden from this user)'}`,
    );
    if (options.format === 'json') await runtime.stdout.write('[');
    for (const [i, planned] of requests.entries()) {
      const prefix = requests.length === 1 ? '' : `[${i + 1}] `;
      try {
        await checkRequest(runtime, connection.target, planned, i + 1, options, fromStdin);
        const response = await send(runtime, session, planned.request);
        if (options.format === 'json') {
          await runtime.stdout.write(
            `${firstJson ? '\n' : ',\n'}${responseJson(planned, response)}`,
          );
          firstJson = false;
        } else if (options.format === 'jsonl') {
          await writeLine(runtime, responseJson(planned, response));
        } else {
          const body = prettyBody(response);
          if (body !== '') await writeLine(runtime, body);
        }
        for (const warning of response.warnings) reporter.warn(warning);
        if (response.truncated) reporter.warn(`${planned.label}: the response was cut`);
        reporter.info(
          `${prefix}${planned.label} · ${statusLine(response.status)} · ${formatDuration(response.durationMs)}`,
        );
        if (response.status >= 400) throw responseError(planned, response);
      } catch (error) {
        if (!(error instanceof JoineryError)) throw error;
        failures += 1;
        reporter.error(formatError(error, { verbose: reporter.verbose }));
        if (!options.continueOnError) break;
      }
    }
    if (options.format === 'json') await runtime.stdout.write(firstJson ? ']\n' : '\n]\n');
  } finally {
    await closeQuietly(connection);
  }
  return failures > 0 ? EXIT.error : EXIT.ok;
}

/** Sends one request; Ctrl+C aborts it and cancels its server task. */
function send(
  runtime: Runtime,
  session: SearchSession,
  request: SearchRequest,
): Promise<SearchResponse> {
  return cancellable(runtime.interrupts, session, (execution) =>
    session.request(request, { signal: execution.signal, executionId: execution.executionId }),
  );
}
