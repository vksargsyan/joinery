import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

/**
 * Where a scheduled run writes (spec: scheduler and automation): a file name from the schedule's
 * template, with `{name}` (the schedule's name, made safe for a file name), `{date}`
 * (YYYY-MM-DD) and `{time}` (HH-MM) in local time, made unique in the folder with a `-2`, `-3`
 * before the extension when a run in the same minute wrote one already. Pruning keeps the newest
 * N entries of the folder whose names the template could have produced, and never touches
 * anything else there.
 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** The schedule's name as a file name part: letters, digits, `.`, `_` and `-`. */
export function nameSlug(name: string): string {
  const slug = name
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|-+$/g, '');
  return slug === '' ? 'schedule' : slug.slice(0, 100);
}

export function renderOutputName(template: string, name: string, at: Date): string {
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}-${pad(at.getMinutes())}`;
  return template
    .replaceAll('{name}', nameSlug(name))
    .replaceAll('{date}', date)
    .replaceAll('{time}', time);
}

/** The extension, counting a compound one (`.sql.gz`, `.tar.gz`) as one. */
function splitExtension(file: string): [string, string] {
  const compound = /(\.[a-z0-9]+\.gz)$/i.exec(file);
  if (compound) return [file.slice(0, -compound[1]!.length), compound[1]!];
  const extension = extname(file);
  return [file.slice(0, file.length - extension.length), extension];
}

/** A path for the run's output in `folder` that nothing there has yet. */
export function uniqueOutputPath(folder: string, file: string): string {
  const [stem, extension] = splitExtension(file);
  let candidate = join(folder, file);
  for (let n = 2; existsSync(candidate); n++) candidate = join(folder, `${stem}-${n}${extension}`);
  return candidate;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches the names the template produces for this schedule, uniqueness suffix included. */
export function outputPattern(template: string, name: string): RegExp {
  const [stem, extension] = splitExtension(template);
  const pattern = escape(stem)
    .replaceAll(escape('{name}'), escape(nameSlug(name)))
    .replaceAll(escape('{date}'), '\\d{4}-\\d{2}-\\d{2}')
    .replaceAll(escape('{time}'), '\\d{2}-\\d{2}');
  return new RegExp(`^${pattern}(?:-\\d+)?${escape(extension)}$`);
}

/**
 * Deletes all but the newest `keep` outputs of the schedule in `folder`; returns what it
 * deleted. A folder that cannot be read prunes nothing.
 */
export async function pruneOutputs(
  folder: string,
  template: string,
  name: string,
  keep: number,
): Promise<string[]> {
  const pattern = outputPattern(template, name);
  let entries: string[];
  try {
    entries = (await readdir(folder)).filter((entry) => pattern.test(entry));
  } catch {
    return [];
  }
  const dated = await Promise.all(
    entries.map(async (entry) => {
      const path = join(folder, entry);
      try {
        return { path, time: (await stat(path)).mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );
  const newestFirst = dated
    .filter((e): e is { path: string; time: number } => e !== undefined)
    .sort((a, b) => b.time - a.time || b.path.localeCompare(a.path));
  const deleted: string[] = [];
  for (const { path } of newestFirst.slice(keep)) {
    try {
      await rm(path, { recursive: true, force: true });
      deleted.push(path);
    } catch {
      // Left for the next run to try again.
    }
  }
  return deleted;
}
