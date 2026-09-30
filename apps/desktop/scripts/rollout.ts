import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';

/**
 * Staged rollout (spec §20): sets the share of installs that are offered a release, as
 * `stagingPercentage` in its update metadata (`latest.yml`, `latest-mac.yml`,
 * `latest-linux.yml`, `latest-linux-arm64.yml`; a beta release carries the same names).
 * electron-updater compares it with a random id each install keeps in its user data directory,
 * so the machines already in stay in as the percentage grows. 100 removes the field (everyone);
 * 0 halts a rollout. test/update-feed.test.ts checks this against electron-updater itself.
 *
 *   node scripts/rollout.ts 20 dist      (every metadata file in dist/)
 *   node scripts/rollout.ts 100 latest.yml latest-mac.yml
 *
 * docs/releasing.md shows how to change it on a published release.
 */

/** The update metadata files electron-builder writes for each channel and platform. */
export const UPDATE_METADATA = /^(?:latest|beta|alpha)(?:-mac|-linux(?:-arm64|-arm)?)?\.yml$/;

/** Sets (or, at 100, removes) the top-level `stagingPercentage` of one metadata file. */
export function setStagingPercentage(text: string, percent: number): string {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new RangeError(`The rollout must be a whole percentage from 0 to 100, not ${percent}`);
  }
  const before = load(text) as { version?: unknown; files?: unknown } | null;
  if (!before || typeof before.version !== 'string' || !Array.isArray(before.files)) {
    throw new Error('Not electron-builder update metadata (no version or files)');
  }
  const lines = text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const kept = lines.filter((line) => !/^stagingPercentage:/.test(line));
  if (percent < 100) kept.push(`stagingPercentage: ${percent}`);
  const next = `${kept.join('\n')}\n`;
  const after = load(next) as { stagingPercentage?: unknown };
  if ((after.stagingPercentage ?? 100) !== percent) throw new Error('The edit did not take');
  return next;
}

/** The metadata files named, or found in the directories named. */
export function metadataFiles(paths: readonly string[]): string[] {
  const files = paths.flatMap((path) =>
    statSync(path).isDirectory()
      ? readdirSync(path)
          .filter((name) => UPDATE_METADATA.test(name))
          .sort()
          .map((name) => join(path, name))
      : [path],
  );
  for (const file of files) {
    if (!UPDATE_METADATA.test(basename(file))) throw new Error(`${file} is not update metadata`);
  }
  return files;
}

function main(): void {
  const [percentArg, ...paths] = process.argv.slice(2);
  if (percentArg === undefined || paths.length === 0) {
    throw new Error('Usage: rollout.ts <percent 0-100> <directory | latest*.yml | beta*.yml>...');
  }
  const percent = Number(percentArg);
  const files = metadataFiles(paths);
  if (files.length === 0) throw new Error(`No update metadata in ${paths.join(', ')}`);
  for (const file of files) {
    writeFileSync(file, setStagingPercentage(readFileSync(file, 'utf8'), percent));
    console.log(`${file}: ${percent === 100 ? 'every install' : `${percent} % of installs`}`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
