import type { OutputStream } from './context';
import { displayWidth, truncateToWidth } from './output/width';

export interface ReporterOptions {
  /** Print debug lines. */
  readonly verbose?: boolean;
  /** Suppress informational lines (status, summaries); warnings and errors still print. */
  readonly quiet?: boolean;
  /** Colour output; defaults to on for terminals unless NO_COLOR is set. */
  readonly color?: boolean;
  readonly now?: () => number;
}

const PROGRESS_INTERVAL_MS = 80;

/**
 * Diagnostics go to stderr through here (progress, status lines, notices, warnings, errors),
 * so stdout carries only each command's result and can be piped. It also owns the transient
 * progress line: other output clears it first, so progress never interleaves with messages.
 */
export class Reporter {
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly style: Style;
  readonly #stream: OutputStream;
  readonly #now: () => number;
  #progress = '';
  #lastProgressAt = -Infinity;

  constructor(stream: OutputStream, options: ReporterOptions = {}) {
    this.#stream = stream;
    this.verbose = options.verbose ?? false;
    this.quiet = options.quiet ?? false;
    this.style = new Style(options.color ?? stream.isTTY === true);
    this.#now = options.now ?? (() => performance.now());
  }

  /** True when progress lines are shown (stderr is a terminal). */
  get interactive(): boolean {
    return this.#stream.isTTY === true;
  }

  /** An informational line; hidden by --quiet. */
  info(message: string): void {
    if (!this.quiet) this.#print(message);
  }

  /** A line that prints even with --quiet (command results that belong on stderr). */
  print(message: string): void {
    this.#print(message);
  }

  warn(message: string): void {
    this.#print(`${this.style.yellow('warning:')} ${message}`);
  }

  /** Error lines as `formatError` builds them. */
  error(lines: readonly string[]): void {
    const [first = '', ...rest] = lines;
    this.#print(
      [
        first.startsWith('error:') ? `${this.style.red('error:')}${first.slice(6)}` : first,
        ...rest,
      ].join('\n'),
    );
  }

  /** A debug line for --verbose. Callers pass only redacted text. */
  debug(message: string): void {
    if (this.verbose) this.#print(this.style.dim(`debug: ${message}`));
  }

  /** Shows or replaces the progress line (terminals only, throttled unless `force`). */
  progress(text: string, force = false): void {
    if (!this.interactive || this.quiet) return;
    const now = this.#now();
    if (!force && now - this.#lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.#lastProgressAt = now;
    const width = Math.max(10, (this.#stream.columns ?? 80) - 1);
    const line = displayWidth(text) > width ? truncateToWidth(text, width) : text;
    this.#stream.write(`\r\x1b[K${line}`);
    this.#progress = line;
  }

  /** Removes the progress line, if one is showing. */
  clearProgress(): void {
    if (this.#progress === '') return;
    this.#stream.write('\r\x1b[K');
    this.#progress = '';
  }

  #print(message: string): void {
    const progress = this.#progress;
    this.clearProgress();
    this.#stream.write(`${message}\n`);
    if (progress !== '') {
      this.#stream.write(progress);
      this.#progress = progress;
    }
  }
}

/** ANSI colours, or plain text when colour is off (not a terminal, NO_COLOR, --no-color). */
export class Style {
  constructor(readonly enabled: boolean) {}

  green(text: string): string {
    return this.#paint(text, 32);
  }

  red(text: string): string {
    return this.#paint(text, 31);
  }

  yellow(text: string): string {
    return this.#paint(text, 33);
  }

  dim(text: string): string {
    return this.#paint(text, 2);
  }

  bold(text: string): string {
    return this.#paint(text, 1);
  }

  #paint(text: string, code: number): string {
    return this.enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
  }
}
