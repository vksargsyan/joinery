/**
 * pg_dump scripts are written for the pg_dump's own version: a newer client emits settings an
 * older server rejects (`SET transaction_timeout = 0;` from recent 13-16 minor releases on,
 * for example), and psql with ON_ERROR_STOP would stop there. This filter drops top-level
 * `SET name = value;` lines for settings the target server does not have, leaving COPY data
 * untouched, so a native restore into an older server still stops on real errors only.
 */

const NEWLINE = 0x0a;
const SET_LINE = /^SET ([a-z_][a-z0-9_.]*) = .*;$/;
const COPY_START = /^COPY .* FROM stdin;$/;

export async function* withoutUnknownSettings(
  source: AsyncIterable<Uint8Array>,
  known: ReadonlySet<string>,
  onSkip: (setting: string) => void,
): AsyncGenerator<Uint8Array> {
  let pending = Buffer.alloc(0);
  let inCopy = false;
  const out: Buffer[] = [];
  /** Queues a line with its newline; false when the line is dropped. */
  const handle = (line: Buffer): boolean => {
    if (inCopy) {
      if (line.length === 2 && line[0] === 0x5c && line[1] === 0x2e) inCopy = false;
    } else if (line.length < 512) {
      const text = line.toString('latin1').replace(/\r$/, '');
      if (COPY_START.test(text)) inCopy = true;
      const set = SET_LINE.exec(text);
      if (set && !known.has(set[1]!)) {
        onSkip(set[1]!);
        return false;
      }
    }
    out.push(line, Buffer.from([NEWLINE]));
    return true;
  };
  for await (const chunk of source) {
    pending = pending.length === 0 ? Buffer.from(chunk) : Buffer.concat([pending, chunk]);
    let start = 0;
    let at: number;
    while ((at = pending.indexOf(NEWLINE, start)) >= 0) {
      handle(pending.subarray(start, at));
      start = at + 1;
    }
    pending = pending.subarray(start);
    if (out.length > 0) yield Buffer.concat(out.splice(0));
  }
  // The last line had no newline; keep it that way.
  if (pending.length > 0 && handle(pending)) out.pop();
  if (out.length > 0) yield Buffer.concat(out.splice(0));
}

/**
 * A one-way byte channel between two tools (pg_restore's script into psql), with backpressure:
 * `write` waits while the reader is behind. After `end`, writes are dropped, so a writer whose
 * reader stopped early can run to its end.
 */
export class BytePipe implements AsyncIterable<Uint8Array> {
  readonly #queue: Uint8Array[] = [];
  #ended = false;
  #error: unknown;
  #wakeReader: (() => void) | undefined;
  #wakeWriter: (() => void) | undefined;

  async write(chunk: Uint8Array): Promise<void> {
    while (this.#queue.length >= 16 && !this.#ended) {
      await new Promise<void>((resolve) => {
        this.#wakeWriter = resolve;
      });
    }
    if (this.#ended) return;
    this.#queue.push(chunk);
    this.#wakeReader?.();
  }

  end(error?: unknown): void {
    this.#ended = true;
    this.#error ??= error;
    this.#wakeReader?.();
    this.#wakeWriter?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
    for (;;) {
      const next = this.#queue.shift();
      if (next !== undefined) {
        this.#wakeWriter?.();
        yield next;
        continue;
      }
      if (this.#ended) {
        if (this.#error !== undefined) throw this.#error;
        return;
      }
      await new Promise<void>((resolve) => {
        this.#wakeReader = resolve;
      });
    }
  }
}
