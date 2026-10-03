import type { OutputStream } from '../context';
import { BrokenPipeError } from '../errors';

/**
 * Writes text to a stream with backpressure: when the stream's buffer is full, `write` waits
 * for 'drain', so result rows never pile up in memory faster than the consumer reads them. A
 * closed pipe (EPIPE, e.g. `querybara query ... | head`) turns into BrokenPipeError.
 */
export class Sink {
  readonly #stream: OutputStream;
  #broken = false;
  readonly #onError = (error: Error): void => {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') this.#broken = true;
  };

  constructor(stream: OutputStream) {
    this.#stream = stream;
    stream.on('error', this.#onError);
  }

  get isTTY(): boolean {
    return this.#stream.isTTY === true;
  }

  get columns(): number | undefined {
    return this.#stream.columns;
  }

  async write(text: string): Promise<void> {
    if (this.#broken) throw new BrokenPipeError();
    if (text === '') return;
    if (this.#stream.write(text)) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        this.#stream.removeListener('drain', done);
        this.#stream.removeListener('close', done);
        this.#stream.removeListener('error', done);
        resolve();
      };
      this.#stream.once('drain', done);
      this.#stream.once('close', done);
      this.#stream.once('error', done);
    });
    if (this.#broken) throw new BrokenPipeError();
  }

  /** Stops listening for errors on the stream. */
  dispose(): void {
    this.#stream.removeListener('error', this.#onError as (...args: unknown[]) => void);
  }
}
