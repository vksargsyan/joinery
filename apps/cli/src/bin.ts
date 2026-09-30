#!/usr/bin/env -S node --no-warnings=ExperimentalWarning
import { nodeContext } from './node-context';
import { runCli } from './program';
import { silenceSqliteWarning } from './warnings';

// Must run before the first tick: node:sqlite's warning is emitted on it.
silenceSqliteWarning();

// A reader that goes away (`| head`) must not crash the process; the sink stops writing.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error;
});

const code = await runCli(process.argv.slice(2), nodeContext());
process.exitCode = code;

// Let buffered output reach a pipe before exiting; then exit even if a driver left a timer or
// socket behind.
const flush = (stream: NodeJS.WriteStream): Promise<void> =>
  new Promise((resolve) => {
    if (stream.destroyed || !stream.writable) resolve();
    else stream.write('', () => resolve());
  });
await Promise.race([
  Promise.all([flush(process.stdout), flush(process.stderr)]),
  new Promise((resolve) => setTimeout(resolve, 2_000)),
]);
process.exit(code);
