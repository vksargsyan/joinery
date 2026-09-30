import type { CliContext } from './context';
import { connect, type Connection } from './connect';
import type { Interrupts } from './interrupt';
import type { Sink } from './output/sink';
import type { Reporter, Style } from './reporter';
import type { StoreHandle } from './store';
import { resolveTarget, type Target, type TargetOverrides } from './target';
import type { Tunnels } from './tunnels';

/**
 * What every command gets. stdout carries the command's result (rows, the diff, test steps,
 * scripts, JSON) and nothing else, so it can be piped; progress, status lines, warnings and
 * errors go to stderr through the reporter.
 */
export interface Runtime {
  readonly ctx: CliContext;
  readonly reporter: Reporter;
  readonly stdout: Sink;
  /** Colours for stdout (on for terminals unless NO_COLOR or --no-color). */
  readonly out: Style;
  readonly store: StoreHandle;
  readonly interrupts: Interrupts;
  /** SSH tunnels and proxies of this run; closed before the process exits. */
  readonly tunnels: Tunnels;
}

export function targetFor(
  runtime: Runtime,
  spec: string,
  overrides: TargetOverrides = {},
): Promise<Target> {
  return resolveTarget(spec, overrides, {
    store: runtime.store,
    env: runtime.ctx.env,
    prompter: runtime.ctx.prompter,
    reporter: runtime.reporter,
  });
}

/** Writes one line of the command's result to stdout. */
export async function writeLine(runtime: Runtime, line: string): Promise<void> {
  if (runtime.stdout.isTTY) runtime.reporter.clearProgress();
  await runtime.stdout.write(`${line}\n`);
}

/** Resolves and connects a target argument. */
export async function openTarget(
  runtime: Runtime,
  spec: string,
  overrides: TargetOverrides = {},
): Promise<Connection> {
  const target = await targetFor(runtime, spec, overrides);
  runtime.interrupts.throwIfInterrupted();
  runtime.reporter.progress(`Connecting to ${target.label}…`, true);
  try {
    return await connect(target, {
      adapters: runtime.ctx.adapters,
      prompter: runtime.ctx.prompter,
      reporter: runtime.reporter,
      transports: () => runtime.tunnels.manager(overrides.tunnel),
    });
  } finally {
    runtime.reporter.clearProgress();
  }
}

/** "1 row" / "3 rows". */
export function plural(
  count: number | bigint,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return `${count.toLocaleString('en-US')} ${count === 1 || count === 1n ? singular : pluralForm}`;
}

/** 12 ms, 1.4 s, 2 min 5 s. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
}
