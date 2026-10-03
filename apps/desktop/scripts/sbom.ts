import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { load } from 'js-yaml';

/**
 * The software bill of materials of a release build (spec §18), in CycloneDX 1.6 JSON. The
 * components are the desktop app's dependency closure in the pnpm lockfile, with their resolved
 * versions, integrity hashes and dependency graph. The build's third-party report
 * (`out/renderer/third-party.json`, scripts/third-party.ts) says which of them the app ships:
 * those are `required`, the build tools `excluded`. Run after `electron-vite build`:
 *
 *   pnpm --filter @querybara/desktop sbom [--out dist/querybara-<version>.cdx.json]
 *
 * SOURCE_DATE_EPOCH, when set, fixes the timestamp (reproducible builds).
 */

interface LockImporter {
  readonly dependencies?: Record<string, { readonly version: string }>;
  readonly devDependencies?: Record<string, { readonly version: string }>;
  readonly optionalDependencies?: Record<string, { readonly version: string }>;
}

interface LockSnapshot {
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

export interface Lockfile {
  readonly lockfileVersion: string;
  readonly importers: Record<string, LockImporter>;
  readonly packages?: Record<
    string,
    { readonly resolution?: { readonly integrity?: string; readonly tarball?: string } }
  >;
  readonly snapshots?: Record<string, LockSnapshot>;
}

/** Parses pnpm-lock.yaml (lockfile format 9). */
export function parseLockfile(text: string): Lockfile {
  const lock = load(text) as Partial<Lockfile> | null;
  if (
    !lock ||
    typeof lock.importers !== 'object' ||
    !String(lock.lockfileVersion).startsWith('9')
  ) {
    throw new Error('Expected a pnpm lockfile, format 9');
  }
  return lock as Lockfile;
}

/** A resolved package: `name@version` (peer suffixes dropped). */
export interface LockPackage {
  readonly name: string;
  readonly version: string;
}

export const keyOf = (p: LockPackage): string => `${p.name}@${p.version}`;

/** `1.2.3(react@19.0.0)` → `1.2.3`; an npm alias `string-width@4.2.3` names another package. */
function resolveRef(name: string, ref: string): { package?: LockPackage; link?: string } {
  if (ref.startsWith('link:')) return { link: ref.slice('link:'.length) };
  const bare = ref.replace(/\(.*$/, '');
  const alias = /^(@?[^@]+)@(.+)$/.exec(bare);
  if (alias && !/^\d/.test(bare)) return { package: { name: alias[1]!, version: alias[2]! } };
  return { package: { name, version: bare } };
}

/** The snapshot of `name@<ref>`; its key keeps the peer suffix. */
function snapshotOf(lock: Lockfile, name: string, ref: string): LockSnapshot | undefined {
  const bare = ref.replace(/\(.*$/, '');
  const aliased = /^(@?[^@]+)@(.+)$/.exec(ref);
  const key = aliased && !/^\d/.test(bare) ? ref : `${name}@${ref}`;
  return lock.snapshots?.[key];
}

export interface Closure {
  /** Every third-party package reached, by `name@version`. */
  readonly packages: Map<string, LockPackage>;
  /** Workspace importers reached (e.g. `packages/core`), the app's own first. */
  readonly importers: string[];
  /** Graph edges by `name@version` or `importer:<path>`. */
  readonly edges: Map<string, Set<string>>;
}

/** Walks the lockfile from one importer through workspace links and package snapshots. */
export function closureOf(lock: Lockfile, importer: string): Closure {
  const packages = new Map<string, LockPackage>();
  const importers: string[] = [];
  const edges = new Map<string, Set<string>>();
  const edge = (from: string, to: string): void => {
    let set = edges.get(from);
    if (!set) edges.set(from, (set = new Set()));
    set.add(to);
  };

  const visited = new Set<string>();
  const visitSnapshot = (name: string, ref: string, from: string): void => {
    const resolved = resolveRef(name, ref);
    if (!resolved.package) return;
    const key = keyOf(resolved.package);
    edge(from, key);
    packages.set(key, resolved.package);
    // The same version with other peers is another snapshot, with possibly other edges.
    const snapshotId = `${name}@${ref}`;
    if (visited.has(snapshotId)) return;
    visited.add(snapshotId);
    const snapshot = snapshotOf(lock, name, ref);
    for (const [dep, depRef] of Object.entries({
      ...snapshot?.dependencies,
      ...snapshot?.optionalDependencies,
    })) {
      visitSnapshot(dep, depRef, key);
    }
  };

  const visitImporter = (path: string): void => {
    if (importers.includes(path)) return;
    const entry = lock.importers[path];
    if (!entry) throw new Error(`The lockfile has no importer ${path}`);
    importers.push(path);
    const from = `importer:${path}`;
    for (const deps of [entry.dependencies, entry.optionalDependencies, entry.devDependencies]) {
      for (const [name, { version }] of Object.entries(deps ?? {})) {
        const resolved = resolveRef(name, version);
        if (resolved.link !== undefined) {
          const target = posix.normalize(posix.join(path, resolved.link));
          edge(from, `importer:${target}`);
          visitImporter(target);
        } else {
          visitSnapshot(name, version, from);
        }
      }
    }
  };

  visitImporter(importer);
  return { packages, importers, edges };
}

/** What the third-party report says about a shipped package. */
export interface ShippedPackage {
  readonly name: string;
  readonly version: string;
  readonly licence: string;
  readonly homepage?: string;
  /** `asset`: a bundled file that is not an npm package (a font), outside the lockfile. */
  readonly source?: 'asset';
}

const SPDX_IDS = new Set([
  '0BSD',
  'Apache-2.0',
  'Artistic-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'OFL-1.1',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

type CdxLicences = [{ license: { id: string } | { name: string } }] | [{ expression: string }];

/** A licence as CycloneDX wants it: a known SPDX id, an SPDX expression, or a free-form name. */
export function cdxLicences(licence: string | undefined): CdxLicences | undefined {
  if (licence === undefined || licence === '' || licence === 'UNKNOWN') return undefined;
  if (SPDX_IDS.has(licence)) return [{ license: { id: licence } }];
  if (/^[\w.+\-() ]+$/.test(licence) && !/^SEE /i.test(licence)) return [{ expression: licence }];
  return [{ license: { name: licence.slice(0, 200) } }];
}

/** `@scope/name` → `pkg:npm/%40scope/name@1.0.0`. */
export function purlOf(p: LockPackage): string {
  const name = p.name.startsWith('@') ? `%40${p.name.slice(1)}` : p.name;
  return `pkg:npm/${name}@${encodeURIComponent(p.version)}`;
}

/** An npm integrity string as a CycloneDX hash (hex). */
export function cdxHash(
  integrity: string | undefined,
): { alg: string; content: string } | undefined {
  const match = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/=]+)$/.exec(integrity ?? '');
  if (!match) return undefined;
  const alg = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' }[
    match[1] as 'sha512' | 'sha384' | 'sha256' | 'sha1'
  ];
  return { alg, content: Buffer.from(match[2]!, 'base64').toString('hex') };
}

export interface SbomInput {
  readonly lock: Lockfile;
  /** The app's importer in the lockfile, e.g. `apps/desktop`. */
  readonly importer: string;
  readonly app: { readonly name: string; readonly version: string; readonly repository?: string };
  /** Name and version of each workspace importer. */
  readonly workspace: (path: string) => { readonly name: string; readonly version: string };
  readonly shipped: readonly ShippedPackage[];
  /** The declared licence of a package the app does not ship (a build tool). */
  readonly licenceOf?: (p: LockPackage) => string | undefined;
  readonly timestamp: Date;
  readonly serialNumber: string;
}

/** The CycloneDX 1.6 document. */
export function buildSbom(input: SbomInput): Record<string, unknown> {
  const closure = closureOf(input.lock, input.importer);
  const assets = input.shipped.filter((p) => p.source === 'asset');
  const shipped = new Map(
    input.shipped.filter((p) => p.source !== 'asset').map((p) => [keyOf(p), p]),
  );
  // A shipped package the lockfile does not explain would be missing from the bill.
  const unexplained = [...shipped.keys()].filter((key) => !closure.packages.has(key));
  if (unexplained.length > 0) {
    throw new Error(`Shipped but not in the ${input.importer} lockfile closure: ${unexplained}`);
  }
  const refOf = new Map<string, string>();
  const appRef = `pkg:generic/${encodeURIComponent(input.app.name.toLowerCase())}@${input.app.version}`;

  const workspaceComponents = closure.importers.slice(1).map((path) => {
    const { name, version } = input.workspace(path);
    const ref = `workspace:${name}@${version}`;
    refOf.set(`importer:${path}`, ref);
    return {
      type: 'library',
      'bom-ref': ref,
      name,
      version,
      scope: 'required',
      description: `First-party workspace package (${path}), bundled into the app`,
    };
  });
  refOf.set(`importer:${input.importer}`, appRef);

  const components = [...closure.packages.values()]
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b), 'en'))
    .map((p) => {
      const key = keyOf(p);
      const ref = purlOf(p);
      refOf.set(key, ref);
      const ships = shipped.get(key);
      const resolution = input.lock.packages?.[key]?.resolution;
      const hash = cdxHash(resolution?.integrity);
      const licences = cdxLicences(ships?.licence ?? input.licenceOf?.(p));
      const references = [
        ...(ships?.homepage === undefined ? [] : [{ type: 'website', url: ships.homepage }]),
        ...(resolution?.tarball === undefined
          ? []
          : [{ type: 'distribution', url: resolution.tarball }]),
      ];
      return {
        type: 'library',
        'bom-ref': ref,
        name: p.name,
        version: p.version,
        purl: ref,
        scope: ships ? 'required' : 'excluded',
        ...(hash ? { hashes: [hash] } : {}),
        ...(licences ? { licenses: licences } : {}),
        ...(references.length > 0 ? { externalReferences: references } : {}),
      };
    });

  const assetComponents = assets.map((p) => {
    const component = assetComponent(p);
    refOf.set(`asset:${keyOf(p)}`, component['bom-ref'] as string);
    return component;
  });

  // Every component gets an entry, those without dependencies too.
  const dependencies = [...refOf.entries()]
    .map(([key, ref]) => ({
      ref,
      dependsOn: [...(closure.edges.get(key) ?? [])]
        .map((target) => refOf.get(target))
        .filter((target): target is string => target !== undefined)
        .sort(),
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref, 'en'));

  return {
    $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    serialNumber: input.serialNumber,
    version: 1,
    metadata: {
      timestamp: input.timestamp.toISOString(),
      lifecycles: [{ phase: 'build' }],
      tools: {
        components: [
          {
            type: 'application',
            name: 'querybara-sbom',
            version: input.app.version,
            description:
              'apps/desktop/scripts/sbom.ts: pnpm lockfile and the build’s licence report',
          },
        ],
      },
      component: {
        type: 'application',
        'bom-ref': appRef,
        name: input.app.name,
        version: input.app.version,
        ...(input.app.repository === undefined
          ? {}
          : { externalReferences: [{ type: 'vcs', url: input.app.repository }] }),
      },
    },
    components: [...workspaceComponents, ...components, ...assetComponents],
    dependencies,
  };
}

/** A bundled asset (a font) as a generic component: it is shipped, and has no npm purl. */
function assetComponent(p: ShippedPackage): Record<string, unknown> {
  const ref = `pkg:generic/${encodeURIComponent(p.name.toLowerCase())}@${encodeURIComponent(p.version)}`;
  const licences = cdxLicences(p.licence);
  return {
    type: 'library',
    'bom-ref': ref,
    name: p.name,
    version: p.version,
    purl: ref,
    scope: 'required',
    ...(licences ? { licenses: licences } : {}),
    ...(p.homepage === undefined
      ? {}
      : { externalReferences: [{ type: 'website', url: p.homepage }] }),
  };
}

/** Maps `name@version` to the package's directory in pnpm's virtual store. */
function virtualStore(storeDir: string): (p: LockPackage) => string | undefined {
  let entries: string[] = [];
  try {
    entries = readdirSync(storeDir);
  } catch {
    // No installed packages: licences of build tools stay unknown.
  }
  return (p) => {
    const prefix = `${p.name.replace('/', '+')}@${p.version}`;
    const dir = entries.find((e) => e === prefix || e.startsWith(`${prefix}_`));
    return dir === undefined ? undefined : join(storeDir, dir, 'node_modules', p.name);
  };
}

function main(): void {
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const repoRoot = resolve(appDir, '../..');
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      report: { type: 'string', default: join(appDir, 'out/renderer/third-party.json') },
      lockfile: { type: 'string', default: join(repoRoot, 'pnpm-lock.yaml') },
    },
  });
  const appPackage = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as {
    productName: string;
    version: string;
  };
  if (!existsSync(values.report)) {
    throw new Error(`${values.report} is missing: run electron-vite build first`);
  }
  const report = JSON.parse(readFileSync(values.report, 'utf8')) as {
    packages: ShippedPackage[];
  };
  const packageDir = virtualStore(join(repoRoot, 'node_modules/.pnpm'));
  const epoch = process.env['SOURCE_DATE_EPOCH'];
  const bom = buildSbom({
    lock: parseLockfile(readFileSync(values.lockfile, 'utf8')),
    importer: posix.normalize(appDir.slice(repoRoot.length + 1).replace(/\\/g, '/')),
    app: {
      name: appPackage.productName,
      version: appPackage.version,
      repository: 'https://github.com/vksargsyan/querybara',
    },
    workspace: (path) => {
      const pkg = JSON.parse(readFileSync(join(repoRoot, path, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
      };
      return { name: pkg.name, version: pkg.version };
    },
    shipped: report.packages,
    licenceOf: (p) => {
      const dir = packageDir(p);
      if (dir === undefined || !existsSync(join(dir, 'package.json'))) return undefined;
      const { license } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        license?: unknown;
      };
      return typeof license === 'string' ? license : undefined;
    },
    timestamp: epoch === undefined ? new Date() : new Date(Number(epoch) * 1000),
    serialNumber: `urn:uuid:${randomUUID()}`,
  });
  const out = values.out ?? join(appDir, 'dist', `querybara-${appPackage.version}.cdx.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(bom, null, 2)}\n`);
  const components = bom['components'] as { scope: string }[];
  const required = components.filter((c) => c.scope === 'required').length;
  console.log(`${out}: ${components.length} components, ${required} shipped in the app`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
