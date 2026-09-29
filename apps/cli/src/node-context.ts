import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

import { defaultAdapters } from './connect';
import type { CliContext, ConfirmAnswer, Prompter } from './context';
import { InterruptedError } from './errors';

/** The real process: stdio, environment, SIGINT, terminal prompts and the bundled drivers. */
export function nodeContext(): CliContext {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    platform: process.platform,
    homedir: homedir(),
    cwd: process.cwd(),
    prompter: terminalPrompter(process.stdin, process.stderr),
    signals: {
      onInterrupt(handler) {
        process.on('SIGINT', handler);
        return () => void process.off('SIGINT', handler);
      },
    },
    adapters: defaultAdapters,
    now: () => performance.now(),
  };
}

/**
 * Prompts on the terminal: questions and secrets are written to stderr and read from stdin,
 * which must both be terminals. Secrets are read in raw mode and never echoed. Ctrl+C while
 * asking rejects with InterruptedError (exit 130).
 */
export function terminalPrompter(stdin: NodeJS.ReadStream, stderr: NodeJS.WriteStream): Prompter {
  const interactive = stdin.isTTY === true && stderr.isTTY === true;

  const line = (question: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const rl = createInterface({ input: stdin, output: stderr, terminal: true });
      rl.on('SIGINT', () => {
        rl.close();
        stderr.write('\n');
        reject(new InterruptedError());
      });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });

  const secret = (label: string): Promise<string> =>
    new Promise((resolve, reject) => {
      stderr.write(label);
      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdin.setEncoding('utf8');
      stdin.resume();
      let value = '';
      const finish = (error?: Error): void => {
        stdin.removeListener('data', onData);
        stdin.setRawMode(wasRaw);
        stdin.pause();
        stderr.write('\n');
        if (error) reject(error);
        else resolve(value);
      };
      const onData = (chunk: string | Buffer): void => {
        const text = String(chunk);
        // Arrow keys and other escape sequences are not part of a password.
        if (text.startsWith('\x1b')) return;
        for (const char of text) {
          if (char === '\r' || char === '\n' || char === '\u0004') return finish();
          if (char === '\u0003') return finish(new InterruptedError());
          if (char === '\u007f' || char === '\b') value = Array.from(value).slice(0, -1).join('');
          else if (char >= ' ') value += char;
        }
      };
      stdin.on('data', onData);
    });

  return {
    interactive,
    secret: (label) => (interactive ? secret(label) : Promise.reject(notInteractive())),
    text: (label) => (interactive ? line(label) : Promise.reject(notInteractive())),
    async confirm(question, options = {}): Promise<ConfirmAnswer> {
      if (!interactive) throw notInteractive();
      const choices = options.allowAll ? '[y]es, [N]o, [a]ll' : '[y/N]';
      for (;;) {
        const answer = (await line(`${question} ${choices} `)).trim().toLowerCase();
        if (answer === '' || answer === 'n' || answer === 'no') return 'no';
        if (answer === 'y' || answer === 'yes') return 'yes';
        if (options.allowAll && (answer === 'a' || answer === 'all')) return 'all';
      }
    },
  };
}

function notInteractive(): Error {
  return new Error('No terminal to ask on');
}
