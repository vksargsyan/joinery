import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { Plugin, Rollup } from 'vite';

import {
  THIRD_PARTY_NOTICES,
  THIRD_PARTY_REPORT,
  type ShippedIn,
  type ThirdPartyPackage,
  type ThirdPartyReport,
} from '../src/shared/third-party';

/**
 * The third-party licence report (spec §20, "Audit third-party licences before release"). A Vite
 * plugin records which npm packages each build (main, preload, renderer and its workers) put
 * into `out/`, and the renderer build writes the report next to its assets:
 *
 * - `third-party.json` (src/shared/third-party.ts), read by the About box and by the SBOM generator (scripts/sbom.ts);
 * - `THIRD_PARTY_NOTICES.txt`, the same packages with their licence and notice texts.
 *
 * Only code that ends up in the app counts: a module tree-shaken out of every chunk does not
 * make its package shipped. First-party workspace packages (not under node_modules) are left
 * out, and Electron, which is not bundled but is the runtime, is added.
 */

/**
 * The npm package directory a bundled file belongs to: the path up to the package's own folder
 * after the last `node_modules`, so pnpm's `.pnpm/<name>@<version>/node_modules/<name>` layout
 * resolves to the real package. Undefined for first-party files and virtual modules.
 */
export function packageDirOf(file: string): string | undefined {
  if (file.startsWith('\0')) return undefined;
  const clean = file.replace(/[?#].*$/, '').replace(/\\/g, '/');
  const marker = '/node_modules/';
  const at = clean.lastIndexOf(marker);
  if (at < 0) return undefined;
  const rest = clean.slice(at + marker.length).split('/');
  const segments = rest[0]?.startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
  if (segments.length === 0 || segments.some((s) => s === '' || s === '.pnpm')) return undefined;
  return clean.slice(0, at + marker.length) + segments.join('/');
}

interface PackageJson {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly license?: unknown;
  readonly licenses?: unknown;
  readonly homepage?: unknown;
  readonly repository?: unknown;
}

/**
 * The licence a package.json declares, as one SPDX expression: the `license` string, or the
 * deprecated `{ type }` object and `licenses` array (joined with OR, as npm reads them).
 */
export function declaredLicence(pkg: PackageJson): string | undefined {
  const typeOf = (value: unknown): string | undefined => {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'object' && value !== null && 'type' in value) {
      const type = (value as { type: unknown }).type;
      return typeof type === 'string' && type.trim() !== '' ? type.trim() : undefined;
    }
    return undefined;
  };
  const single = typeOf(pkg.license);
  if (single !== undefined) return single;
  if (Array.isArray(pkg.licenses)) {
    const all = pkg.licenses.map(typeOf).filter((t): t is string => t !== undefined);
    if (all.length === 1) return all[0];
    if (all.length > 1) return `(${all.join(' OR ')})`;
  }
  return undefined;
}

/** A browsable https link for the package: its homepage, or its repository. */
export function homepageOf(pkg: PackageJson): string | undefined {
  const candidates: unknown[] = [pkg.homepage];
  const repository = pkg.repository;
  candidates.push(
    typeof repository === 'object' && repository !== null && 'url' in repository
      ? (repository as { url: unknown }).url
      : repository,
  );
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    let url = candidate.trim().replace(/^git\+/, '');
    const shorthand = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(url);
    if (shorthand) url = `https://github.com/${shorthand[1]}`;
    url = url.replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
    if (/^https:\/\/[^\s/]+\//.test(url)) return url;
  }
  return undefined;
}

const LICENCE_FILE = /^(?:licen[cs]e|copying)(?:[.-][\w.-]*)?$/i;
const NOTICE_FILE = /^(?:notice|third[-_]?party[-_]?notices)(?:[.-][\w.-]*)?$/i;

function readTexts(dir: string, pattern: RegExp): string | undefined {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => pattern.test(name));
  } catch {
    return undefined;
  }
  const texts = names
    .sort()
    .map((name) => {
      try {
        return readFileSync(join(dir, name), 'utf8').trim();
      } catch {
        return '';
      }
    })
    .filter((text) => text !== '');
  return texts.length === 0 ? undefined : texts.join('\n\n');
}

/** Reads one package's name, version, licence and texts from its directory. */
export function readPackage(dir: string, shippedIn: Iterable<ShippedIn>): ThirdPartyPackage {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJson;
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') {
    throw new Error(`${dir}/package.json has no name or version`);
  }
  const homepage = homepageOf(pkg);
  const licenceText = readTexts(dir, LICENCE_FILE);
  const noticeText = readTexts(dir, NOTICE_FILE);
  return {
    name: pkg.name,
    version: pkg.version,
    licence: declaredLicence(pkg) ?? 'UNKNOWN',
    ...(homepage === undefined ? {} : { homepage }),
    ...(licenceText === undefined ? {} : { licenceText }),
    ...(noticeText === undefined ? {} : { noticeText }),
    shippedIn: [...new Set(shippedIn)].sort(),
  };
}

/**
 * The report for a set of package directories, sorted by name and version. `reviewed` gives the
 * licence a person established for a package (`name@version`) whose package.json declares none
 * or a custom one; it replaces the declared licence.
 */
export function buildReport(
  dirs: ReadonlyMap<string, ReadonlySet<ShippedIn>>,
  reviewed: Readonly<Record<string, string>> = {},
): ThirdPartyReport {
  const packages = new Map<string, ThirdPartyPackage>();
  for (const [dir, shippedIn] of dirs) {
    const declared = readPackage(dir, shippedIn);
    const key = `${declared.name}@${declared.version}`;
    const licence = reviewed[key];
    const read = licence === undefined ? declared : { ...declared, licence };
    const known = packages.get(key);
    packages.set(
      key,
      known
        ? { ...known, shippedIn: [...new Set([...known.shippedIn, ...read.shippedIn])].sort() }
        : read,
    );
  }
  return {
    format: 1,
    packages: [...packages.values()].sort(
      (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'),
    ),
  };
}

/**
 * A bundled file that is not an npm package (a font), with its licence file. It is listed in
 * the report like a package, marked `source: 'asset'`, and the SBOM names it as a generic
 * component instead of looking for it in the lockfile.
 */
export interface ThirdPartyAsset {
  readonly name: string;
  readonly version: string;
  /** An SPDX expression, e.g. "OFL-1.1". */
  readonly licence: string;
  readonly homepage?: string;
  /** The licence text, relative to the app directory. */
  readonly licenceFile: string;
  readonly shippedIn: ShippedIn;
}

export function readAsset(root: string, asset: ThirdPartyAsset): ThirdPartyPackage {
  return {
    name: asset.name,
    version: asset.version,
    licence: asset.licence,
    ...(asset.homepage === undefined ? {} : { homepage: asset.homepage }),
    licenceText: readFileSync(join(root, asset.licenceFile), 'utf8').trim(),
    shippedIn: [asset.shippedIn],
    source: 'asset',
  };
}

/** The report with bundled assets added, in the same name order. */
export function withAssets(
  report: ThirdPartyReport,
  assets: readonly ThirdPartyPackage[],
): ThirdPartyReport {
  return {
    ...report,
    packages: [...report.packages, ...assets].sort(
      (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'),
    ),
  };
}

/** Licences whose terms the app cannot meet by shipping notices (spec §20: no GPL family). */
const COPYLEFT = /\b(?:A|L)?GPL|\bSSPL\b/i;

/**
 * Why a shipped package's licence is not acceptable, or undefined when it is. Copyleft: every
 * choice of an `OR` expression is AGPL, GPL, LGPL or SSPL (a package that offers a permissive
 * alternative, `MIT OR GPL-3.0`, is fine). Unknown: no licence, npm's `UNLICENSED` (not licensed
 * for use) or `SEE LICENSE IN <file>`, which a person must read first (`reviewed`).
 */
export function licenceProblem(licence: string): string | undefined {
  const text = licence.trim();
  if (text === 'UNKNOWN' || text === '') return 'declares no licence';
  if (text === 'UNLICENSED') return 'is not licensed for use (UNLICENSED)';
  if (/^SEE LICEN[CS]E IN\b/i.test(text)) return `has a custom licence (${text})`;
  const choices = text.replace(/[()]/g, ' ').split(/\s+OR\s+/i);
  return choices.every((choice) => COPYLEFT.test(choice))
    ? `${text} is a copyleft licence`
    : undefined;
}

/** The plain-text notices file shipped in the app and attached to releases. */
export function renderNotices(report: ThirdPartyReport, productName: string): string {
  const rule = '='.repeat(78);
  const lines = [
    `${productName} third-party notices`,
    '',
    `${productName} includes the open-source packages and fonts listed below, each under its own licence,`,
    'reproduced after its name. The Electron runtime also carries the licences of Chromium and',
    'Node.js, in LICENSE.electron.txt and LICENSES.chromium.html next to the executable.',
    '',
    ...report.packages.map((p) => `  ${p.name} ${p.version}  (${p.licence})`),
    '',
  ];
  for (const p of report.packages) {
    lines.push(rule, `${p.name} ${p.version}`, `Licence: ${p.licence}`);
    if (p.homepage !== undefined) lines.push(p.homepage);
    lines.push('');
    lines.push(
      p.licenceText ?? `The package ships no licence file; it is licensed under ${p.licence}.`,
    );
    if (p.noticeText !== undefined) lines.push('', p.noticeText);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/** The files a rendered chunk carries code from; CSS counts though it renders no JavaScript. */
function shippedModules(bundle: Rollup.OutputBundle): string[] {
  const ids: string[] = [];
  for (const output of Object.values(bundle)) {
    if (output.type !== 'chunk') continue;
    for (const [id, info] of Object.entries(output.modules)) {
      if (info.renderedLength > 0 || /\.css(?:$|\?)/.test(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * The plugins: `collect(target)` goes into each build that ships code (for the renderer, its
 * worker builds too), `emit()` into the renderer build, the last electron-vite runs. `root` is
 * the app directory, from which `extra` packages are resolved: shipped code no bundle sees as
 * a module (the Electron runtime, CSS a plugin compiles in). The build fails when a shipped
 * package's licence is copyleft or unknown (`licenceProblem`); `reviewed` settles the unknown
 * ones (see `buildReport`).
 */
export function thirdPartyNotices(options: {
  readonly root: string;
  readonly productName: string;
  readonly extra?: readonly { readonly name: string; readonly shippedIn: ShippedIn }[];
  readonly reviewed?: Readonly<Record<string, string>>;
  readonly assets?: readonly ThirdPartyAsset[];
}): { collect(target: Exclude<ShippedIn, 'runtime'>): Plugin; emit(): Plugin } {
  const found = new Map<string, Set<ShippedIn>>();
  const add = (dir: string, target: ShippedIn): void => {
    let targets = found.get(dir);
    if (!targets) found.set(dir, (targets = new Set()));
    targets.add(target);
  };
  const require = createRequire(join(options.root, 'package.json'));
  return {
    collect: (target) => ({
      name: `joinery:third-party:${target}`,
      apply: 'build',
      generateBundle(_output, bundle) {
        for (const id of shippedModules(bundle)) {
          const dir = packageDirOf(id);
          if (dir !== undefined && existsSync(join(dir, 'package.json'))) add(dir, target);
        }
      },
    }),
    emit: () => ({
      name: 'joinery:third-party:emit',
      apply: 'build',
      // After the renderer's own collector, which is listed first.
      enforce: 'post',
      generateBundle() {
        for (const { name, shippedIn } of options.extra ?? []) {
          add(dirname(require.resolve(`${name}/package.json`)), shippedIn);
        }
        const report = withAssets(
          buildReport(found, options.reviewed),
          (options.assets ?? []).map((asset) => readAsset(options.root, asset)),
        );
        const problems = report.packages.flatMap((p) => {
          const problem = licenceProblem(p.licence);
          return problem === undefined ? [] : [`${p.name}@${p.version} ${problem}`];
        });
        if (problems.length > 0) {
          this.error(
            [
              'Shipped packages whose licence the app cannot use or has not reviewed (spec §20):',
              ...problems,
              'Replace a copyleft package; read an unknown licence and add it to `reviewed` in electron.vite.config.ts.',
            ].join('\n'),
          );
        }
        this.emitFile({
          type: 'asset',
          fileName: THIRD_PARTY_REPORT,
          source: JSON.stringify(report),
        });
        this.emitFile({
          type: 'asset',
          fileName: THIRD_PARTY_NOTICES,
          source: renderNotices(report, options.productName),
        });
      },
    }),
  };
}
