import {
  CONNECTION_CHECK_STEPS,
  ENGINES,
  toErrorData,
  type ConnectionCheckResult,
  type ConnectionCheckStep,
  type DriverAdapter,
} from '@joinery/core';

import { checkConnectionThroughTransport, needsTransport } from '@joinery/tunnel';

import { missingPasswordHint } from '../connect';
import { EXIT, type ExitCode } from '../errors';
import { formatDuration, targetFor, writeLine, type Runtime } from '../runtime';
import {
  describeEndpoint,
  resolvedProfile,
  withPassword,
  type Target,
  type TargetOverrides,
} from '../target';
import { describeRoute } from '../tunnels';

export interface TestOptions extends TargetOverrides {
  readonly json?: boolean;
}

const STEP_LABELS: Readonly<Record<ConnectionCheckStep, string>> = {
  dns: 'DNS',
  tcp: 'TCP',
  ssh: 'SSH',
  tls: 'TLS',
  auth: 'Auth',
  ping: 'Ping',
  version: 'Version',
};

/**
 * `joinery test <target>`: Test Connection (spec §4). Runs the adapter's stepwise check (DNS,
 * TCP, SSH, TLS, auth, ping, version) and prints ✓ or ✗ per step with the fix hint of the
 * failing one. With an SSH tunnel or a proxy, DNS and TCP check the first server on the way, the
 * SSH step opens the route, and the later steps run through it. Exit 0 when every step passed,
 * 1 when one failed.
 */
export async function testCommand(
  runtime: Runtime,
  spec: string,
  options: TestOptions,
): Promise<ExitCode> {
  const { out } = runtime;
  let target = await targetFor(runtime, spec, options);
  const adapter = runtime.ctx.adapters(target.profile.engine);
  const print = !options.json;
  if (print) {
    const route = describeRoute(target.profile);
    await writeLine(
      runtime,
      `Testing ${target.label} (${ENGINES[target.profile.engine].displayName} at ${describeEndpoint(target.profile)}${route ? ` via ${route}` : ''}, TLS ${target.profile.tls.mode})`,
    );
  }
  let results = await runCheck(runtime, adapter, target, print, options);
  const authFailed = results.some((r) => r.step === 'auth' && r.status === 'failed');
  if (authFailed && !target.passwordKnown && runtime.ctx.prompter.interactive) {
    target = withPassword(
      target,
      await runtime.ctx.prompter.secret(`Password for ${target.label}: `),
    );
    if (print) await writeLine(runtime, 'Retrying with the password…');
    results = await runCheck(runtime, adapter, target, print, options);
  }
  const failed = results.find((r) => r.status === 'failed');
  if (options.json) {
    const report = {
      target: target.label,
      engine: target.profile.engine,
      ok: !failed,
      steps: results,
    };
    await writeLine(runtime, JSON.stringify(report, null, 2));
  } else if (failed) {
    await writeLine(runtime, out.red(`Connection failed at the ${STEP_LABELS[failed.step]} step.`));
    if (failed.step === 'auth' && !target.passwordKnown) {
      await writeLine(runtime, missingPasswordHint(target));
    }
  } else {
    await writeLine(runtime, out.green('Connection OK.'));
  }
  return failed ? EXIT.differences : EXIT.ok;
}

async function runCheck(
  runtime: Runtime,
  adapter: DriverAdapter,
  target: Target,
  print: boolean,
  options: TargetOverrides,
): Promise<ConnectionCheckResult[]> {
  const results: ConnectionCheckResult[] = [];
  const check = needsTransport(target.profile)
    ? checkConnectionThroughTransport(
        adapter,
        resolvedProfile(target),
        runtime.tunnels.manager(options.tunnel),
      )
    : adapter.checkConnection
      ? adapter.checkConnection(resolvedProfile(target))
      : fallbackCheck(adapter, target);
  for await (const result of check) {
    runtime.interrupts.throwIfInterrupted();
    results.push(result);
    if (print) for (const line of stepLines(runtime, result)) await writeLine(runtime, line);
  }
  return results;
}

/** `✓ TCP     127.0.0.1:5432 (2 ms)`, `✗ Auth    <message>` plus the hint, `- SSH     skipped`. */
export function stepLines(runtime: Pick<Runtime, 'out'>, result: ConnectionCheckResult): string[] {
  const { out } = runtime;
  const label = STEP_LABELS[result.step].padEnd(8);
  const time =
    result.status === 'skipped' ? '' : ` ${out.dim(`(${formatDuration(result.durationMs)})`)}`;
  switch (result.status) {
    case 'ok':
      return [`  ${out.green('✓')} ${label}${result.message ?? 'OK'}${time}`];
    case 'failed':
      return [
        `  ${out.red('✗')} ${label}${result.message ?? 'failed'}${time}`,
        ...(result.hint ? [`    ${' '.repeat(8)}hint: ${result.hint}`] : []),
      ];
    default:
      return [out.dim(`  - ${label}${result.message ?? 'skipped'}`)];
  }
}

/** For adapters without `checkConnection`: connect, ping and read the version as one check. */
async function* fallbackCheck(
  adapter: DriverAdapter,
  target: Target,
): AsyncGenerator<ConnectionCheckResult> {
  const started = performance.now();
  try {
    const session = await adapter.connect(resolvedProfile(target));
    try {
      await session.ping();
      for (const step of CONNECTION_CHECK_STEPS) {
        if (step === 'version') {
          yield { step, status: 'ok', durationMs: 0, message: session.serverVersion };
        } else if (step === 'auth' || step === 'ping') {
          yield { step, status: 'ok', durationMs: Math.round(performance.now() - started) };
        } else {
          yield { step, status: 'skipped', durationMs: 0 };
        }
      }
    } finally {
      await session.close().catch(() => undefined);
    }
  } catch (error) {
    const data = toErrorData(error);
    yield {
      step: 'auth',
      status: 'failed',
      durationMs: Math.round(performance.now() - started),
      message: data.message,
      ...(data.hint !== undefined ? { hint: data.hint } : {}),
    };
  }
}
