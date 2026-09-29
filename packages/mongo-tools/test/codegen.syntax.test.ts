import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';

import {
  CODE_EXPORT_LANGUAGES,
  exportQueryCode,
  type CodeLanguage,
  type ExportTarget,
} from '../src';
import { AGGREGATE, FIND, TYPES, bsonDocument } from './codegen-fixtures';

/**
 * Exported programs must at least parse. Each check runs only where its toolchain is installed:
 * `node --check`, `python3 -m py_compile`, `php -l`, `gofmt` (which must also leave the file
 * unchanged) and `javac` stopped after parsing (the driver jars are not needed for that). C# has
 * no parse-only compiler without a project, so it is covered by the goldens alone.
 */

interface Checker {
  readonly language: CodeLanguage;
  readonly available: boolean;
  /** Checks one file; returns the tool's complaint, or '' when the file is fine. */
  check(file: string, dir: string): string;
}

function runs(command: string, args: readonly string[]): boolean {
  return spawnSync(command, args, { stdio: 'ignore', timeout: 30_000 }).error === undefined;
}

function run(
  command: string,
  args: readonly string[],
  cwd?: string,
): { code: number; out: string } {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, cwd });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
    .split('\n')
    .filter((line) => !line.startsWith('Picked up JAVA_TOOL_OPTIONS'))
    .join('\n')
    .trim();
  return { code: result.status ?? -1, out: result.error ? String(result.error) : out };
}

const CHECKERS: readonly Checker[] = [
  {
    language: 'node',
    available: true,
    check: (file) => {
      const { code, out } = run(process.execPath, ['--check', file]);
      return code === 0 ? '' : out;
    },
  },
  {
    language: 'python',
    available: runs('python3', ['--version']),
    check: (file) => {
      const { code, out } = run('python3', ['-m', 'py_compile', file]);
      return code === 0 ? '' : out;
    },
  },
  {
    language: 'php',
    available: runs('php', ['--version']),
    check: (file) => {
      const { code, out } = run('php', ['-l', file]);
      return code === 0 ? '' : out;
    },
  },
  {
    language: 'go',
    available: runs('gofmt', ['-l', '/dev/null']),
    check: (file) => {
      const { code, out } = run('gofmt', ['-l', '-e', file]);
      if (code !== 0) return out;
      // -l names the file when gofmt would change it.
      return out === '' ? '' : `not gofmt-formatted:\n${run('gofmt', ['-d', file]).out}`;
    },
  },
  {
    language: 'java',
    available: runs('javac', ['-version']),
    check: (file, dir) => {
      const { code, out } = run('javac', [
        '-XDshould-stop.ifNoError=PARSE',
        '-XDshould-stop.ifError=PARSE',
        '-d',
        join(dir, 'classes'),
        file,
      ]);
      return code === 0 ? '' : out;
    },
  },
];

const dir = mkdtempSync(join(tmpdir(), 'joinery-code-export-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Programs built from random documents, to catch escaping and layout mistakes. */
function randomTargets(): ExportTarget[] {
  const seed = Number(process.env['JOINERY_FUZZ_SEED'] ?? 20260929);
  const runsCount = Number(process.env['JOINERY_FUZZ_RUNS'] ?? 300);
  const documents = fc.sample(bsonDocument, { numRuns: Math.max(10, runsCount / 10), seed });
  return [
    { kind: 'aggregate', collection: 'fuzz', pipeline: documents.map((doc) => ({ $match: doc })) },
    ...documents.slice(0, 5).map((doc, i): ExportTarget => ({
      kind: 'find',
      collection: `fuzz ${i}`,
      query: { filter: doc, projection: doc, sort: doc, hint: doc, collation: doc },
    })),
  ];
}

describe.each(CHECKERS)('exported $language code', ({ language, available, check }) => {
  const fileName = CODE_EXPORT_LANGUAGES.find((l) => l.id === language)!.fileName;

  it.skipIf(!available)(
    'parses for find, aggregate and every BSON type',
    () => {
      for (const [name, target] of Object.entries({
        find: FIND,
        aggregate: AGGREGATE,
        types: TYPES,
      })) {
        const sub = join(dir, language, name);
        const file = join(sub, fileName);
        mkdirSync(sub, { recursive: true });
        writeFileSync(file, exportQueryCode(target, language, { database: 'shop' }));
        expect(check(file, sub), `${language} ${name}`).toBe('');
      }
    },
    120_000,
  );

  it.skipIf(!available)(
    'parses for random documents',
    () => {
      randomTargets().forEach((target, i) => {
        const sub = join(dir, language, `random-${i}`);
        const file = join(sub, fileName);
        mkdirSync(sub, { recursive: true });
        writeFileSync(file, exportQueryCode(target, language, { database: 'fuzz' }));
        expect(check(file, sub), `${language} random ${i}`).toBe('');
      });
    },
    120_000,
  );
});
