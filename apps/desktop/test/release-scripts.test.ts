import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { load } from 'js-yaml';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';

import { UPDATE_METADATA, metadataFiles, setStagingPercentage } from '../scripts/rollout';
import {
  buildSbom,
  cdxHash,
  cdxLicences,
  closureOf,
  parseLockfile,
  purlOf,
  type Lockfile,
} from '../scripts/sbom';
import {
  buildReport,
  declaredLicence,
  homepageOf,
  licenceProblem,
  packageDirOf,
  readAsset,
  renderNotices,
  thirdPartyNotices,
  withAssets,
} from '../scripts/third-party';
import { thirdPartyReportSchema } from '../src/shared/third-party';

/**
 * The release tooling (spec §18, §20): the third-party licence report the build ships in the
 * About box, the CycloneDX SBOM generated from the lockfile, and the staged-rollout edit of the
 * update metadata.
 */

const scratch = mkdtempSync(join(tmpdir(), 'joinery-release-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A fake package directory under a pnpm-style node_modules. */
function fakePackage(name: string, files: Record<string, string>): string {
  const dir = join(
    scratch,
    'node_modules/.pnpm',
    `${name.replace('/', '+')}@1.0.0/node_modules`,
    name,
  );
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  return dir;
}

describe('the third-party report', () => {
  it('finds the package a bundled file belongs to', () => {
    expect(
      packageDirOf('/r/node_modules/.pnpm/react@19.3.0/node_modules/react/cjs/react.production.js'),
    ).toBe('/r/node_modules/.pnpm/react@19.3.0/node_modules/react');
    expect(
      packageDirOf(
        '/r/node_modules/.pnpm/@radix-ui+react-dialog@1.1.23_x/node_modules/@radix-ui/react-dialog/dist/index.mjs?commonjs-proxy',
      ),
    ).toBe(
      '/r/node_modules/.pnpm/@radix-ui+react-dialog@1.1.23_x/node_modules/@radix-ui/react-dialog',
    );
    expect(packageDirOf('C:\\r\\node_modules\\pg\\lib\\index.js')).toBe('C:/r/node_modules/pg');
    expect(packageDirOf('/r/packages/core/src/index.ts')).toBeUndefined();
    expect(packageDirOf('\0vite/preload-helper.js')).toBeUndefined();
    expect(packageDirOf('/r/node_modules/.pnpm/x')).toBeUndefined();
  });

  it('reads licences the ways package.json declares them', () => {
    expect(declaredLicence({ license: 'MIT' })).toBe('MIT');
    expect(declaredLicence({ license: { type: 'BSD-3-Clause' } })).toBe('BSD-3-Clause');
    expect(declaredLicence({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe(
      '(MIT OR Apache-2.0)',
    );
    expect(declaredLicence({})).toBeUndefined();
    expect(homepageOf({ homepage: 'https://react.dev/' })).toBe('https://react.dev/');
    expect(
      homepageOf({ repository: { url: 'git+https://github.com/brianc/node-postgres.git' } }),
    ).toBe('https://github.com/brianc/node-postgres');
    expect(homepageOf({ repository: 'github:user/repo' })).toBe('https://github.com/user/repo');
    expect(homepageOf({ repository: 'user/repo' })).toBe('https://github.com/user/repo');
    expect(homepageOf({ homepage: 'http://insecure.example/' })).toBeUndefined();
  });

  it('refuses copyleft licences unless a permissive choice is offered', () => {
    for (const ok of [
      'MIT',
      'Apache-2.0',
      '(MIT OR GPL-3.0)',
      'BSD-3-Clause AND ISC',
      'Unlicense',
    ]) {
      expect(licenceProblem(ok)).toBeUndefined();
    }
    for (const bad of [
      'GPL-3.0',
      'AGPL-3.0-only',
      'LGPL-2.1-or-later',
      '(GPL-2.0 OR LGPL-3.0)',
      'SSPL-1.0',
    ]) {
      expect(licenceProblem(bad)).toMatch(/copyleft/);
    }
  });

  it('refuses licences nobody has read yet', () => {
    expect(licenceProblem('UNKNOWN')).toBe('declares no licence');
    expect(licenceProblem('UNLICENSED')).toMatch(/not licensed for use/);
    expect(licenceProblem('SEE LICENSE IN EULA.txt')).toMatch(/custom licence/);
  });

  it('builds the report with licence and notice texts, and renders the notices', () => {
    const a = fakePackage('alpha', {
      'package.json': JSON.stringify({ name: 'alpha', version: '1.0.0', license: 'MIT' }),
      LICENSE: 'MIT licence text',
    });
    const b = fakePackage('@scope/beta', {
      'package.json': JSON.stringify({
        name: '@scope/beta',
        version: '2.0.0',
        license: 'Apache-2.0',
        repository: 'scope/beta',
      }),
      'LICENSE.md': 'Apache text',
      NOTICE: 'Beta notice',
      'ThirdPartyNotices.txt': 'Bundled notices',
    });
    const c = fakePackage('gamma', {
      'package.json': JSON.stringify({ name: 'gamma', version: '0.1.0' }),
    });
    const report = buildReport(
      new Map([
        [b, new Set(['renderer' as const])],
        [a, new Set(['main' as const, 'renderer' as const])],
        [c, new Set(['main' as const])],
      ]),
    );
    expect(thirdPartyReportSchema.parse(report)).toEqual(report);
    expect(report.packages.map((p) => `${p.name}@${p.version}`)).toEqual([
      '@scope/beta@2.0.0',
      'alpha@1.0.0',
      'gamma@0.1.0',
    ]);
    expect(report.packages[0]).toMatchObject({
      licence: 'Apache-2.0',
      homepage: 'https://github.com/scope/beta',
      licenceText: 'Apache text',
      noticeText: 'Beta notice\n\nBundled notices',
      shippedIn: ['renderer'],
    });
    expect(report.packages[1]?.shippedIn).toEqual(['main', 'renderer']);
    expect(report.packages[2]).toMatchObject({ licence: 'UNKNOWN' });
    expect(report.packages[2]?.licenceText).toBeUndefined();

    const text = renderNotices(report, 'Joinery');
    expect(text).toMatch(/^Joinery third-party notices\n/);
    expect(text).toContain('  alpha 1.0.0  (MIT)');
    expect(text).toContain('MIT licence text');
    expect(text).toContain('Beta notice');
    expect(text).toContain('gamma 0.1.0\nLicence: UNKNOWN\n\nThe package ships no licence file');

    const settled = buildReport(new Map([[c, new Set(['main' as const])]]), {
      'gamma@0.1.0': 'MIT',
    });
    expect(settled.packages[0]).toMatchObject({ name: 'gamma', licence: 'MIT' });
  });
});

describe('bundled assets', () => {
  it('lists a font with its licence file, marked as an asset, in name order', () => {
    writeFileSync(join(scratch, 'OFL.txt'), 'SIL Open Font License, Version 1.1\n');
    const font = readAsset(scratch, {
      name: 'Rec Mono (Recursive)',
      version: '1.085',
      licence: 'OFL-1.1',
      homepage: 'https://github.com/arrowtype/recursive',
      licenceFile: 'OFL.txt',
      shippedIn: 'renderer',
    });
    expect(font).toEqual({
      name: 'Rec Mono (Recursive)',
      version: '1.085',
      licence: 'OFL-1.1',
      homepage: 'https://github.com/arrowtype/recursive',
      licenceText: 'SIL Open Font License, Version 1.1',
      shippedIn: ['renderer'],
      source: 'asset',
    });
    expect(licenceProblem(font.licence)).toBeUndefined();
    const npm = { name: 'zod', version: '4.0.0', licence: 'MIT', shippedIn: ['renderer' as const] };
    const report = withAssets({ format: 1, packages: [npm] }, [font]);
    expect(report.packages.map((p) => p.name)).toEqual(['Rec Mono (Recursive)', 'zod']);
    expect(thirdPartyReportSchema.parse(report)).toEqual(report);
    expect(renderNotices(report, 'Joinery')).toContain(
      'Rec Mono (Recursive) 1.085\nLicence: OFL-1.1',
    );
  });
});

describe('the licence check in the build', () => {
  /** A tiny app whose entry uses one package from its own node_modules. */
  function fixtureApp(name: string, pkg: Record<string, unknown>): string {
    const app = join(scratch, `app-${name}`);
    const dir = join(app, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkg }));
    writeFileSync(join(dir, 'index.js'), `export const label = '${name}';\n`);
    writeFileSync(join(dir, 'LICENSE'), `${name} licence text`);
    writeFileSync(
      join(app, 'main.js'),
      `import { label } from '${name}';\ndocument.title = label;\n`,
    );
    return app;
  }

  async function buildApp(app: string) {
    const notices = thirdPartyNotices({ root: app, productName: 'Fixture' });
    const result = await build({
      root: app,
      configFile: false,
      logLevel: 'silent',
      plugins: [notices.collect('renderer'), notices.emit()],
      build: { write: false, minify: false, rollupOptions: { input: join(app, 'main.js') } },
    });
    const outputs = Array.isArray(result) ? result : [result];
    return outputs.flatMap((out) => ('output' in out ? out.output : []));
  }

  it('writes the report of what the bundle shipped', { timeout: 60_000 }, async () => {
    const files = await buildApp(fixtureApp('permissive', { license: 'MIT' }));
    const asset = files.find((file) => file.fileName === 'third-party.json');
    expect(asset?.type).toBe('asset');
    const report = thirdPartyReportSchema.parse(
      JSON.parse(String(asset?.type === 'asset' ? asset.source : '')),
    );
    expect(report.packages).toMatchObject([
      { name: 'permissive', licence: 'MIT', licenceText: 'permissive licence text' },
    ]);
    expect(files.some((file) => file.fileName === 'THIRD_PARTY_NOTICES.txt')).toBe(true);
  });

  it(
    'fails the build when a shipped package is GPL or has no licence',
    { timeout: 60_000 },
    async () => {
      await expect(buildApp(fixtureApp('copyleft', { license: 'GPL-3.0-only' }))).rejects.toThrow(
        /copyleft@1\.0\.0 GPL-3\.0-only is a copyleft licence/,
      );
      await expect(buildApp(fixtureApp('agpl', { license: 'AGPL-3.0-or-later' }))).rejects.toThrow(
        /agpl@1\.0\.0 AGPL-3\.0-or-later is a copyleft licence/,
      );
      await expect(buildApp(fixtureApp('mystery', {}))).rejects.toThrow(
        /mystery@1\.0\.0 declares no licence/,
      );
    },
  );
});

const LOCK = `lockfileVersion: '9.0'
importers:
  apps/desktop:
    devDependencies:
      '@joinery/core':
        specifier: workspace:*
        version: link:../../packages/core
      react-dom:
        specifier: ^19.0.0
        version: 19.0.0(react@19.0.0)
      vite:
        specifier: ^7.0.0
        version: 7.0.0
  packages/core:
    dependencies:
      zod:
        specifier: ^4.0.0
        version: 4.0.0
packages:
  react@19.0.0:
    resolution: {integrity: sha512-AAAA}
  react-dom@19.0.0:
    resolution: {integrity: sha512-BBBB}
  scheduler@0.25.0:
    resolution: {integrity: sha1-CCCC}
  vite@7.0.0:
    resolution: {integrity: sha512-DDDD}
  string-width@4.2.3:
    resolution: {tarball: https://registry.example/string-width-4.2.3.tgz}
  zod@4.0.0:
    resolution: {integrity: sha512-EEEE}
snapshots:
  react@19.0.0: {}
  react-dom@19.0.0(react@19.0.0):
    dependencies:
      react: 19.0.0
      scheduler: 0.25.0
  scheduler@0.25.0: {}
  vite@7.0.0:
    dependencies:
      string-width-cjs: string-width@4.2.3
  string-width@4.2.3: {}
  zod@4.0.0: {}
`;

describe('the SBOM', () => {
  const lock: Lockfile = parseLockfile(LOCK);
  const input = {
    lock,
    importer: 'apps/desktop',
    app: { name: 'Joinery', version: '1.2.3', repository: 'https://github.com/vksargsyan/joinery' },
    workspace: (path: string) => ({
      name: path === 'packages/core' ? '@joinery/core' : path,
      version: '0.0.0',
    }),
    shipped: [
      { name: 'react', version: '19.0.0', licence: 'MIT', homepage: 'https://react.dev/' },
      { name: 'react-dom', version: '19.0.0', licence: 'MIT' },
      { name: 'scheduler', version: '0.25.0', licence: 'MIT' },
      { name: 'zod', version: '4.0.0', licence: 'MIT' },
    ],
    licenceOf: (p: { name: string }) => (p.name === 'vite' ? 'MIT' : undefined),
    timestamp: new Date('2026-09-29T00:00:00Z'),
    serialNumber: 'urn:uuid:3e671687-395b-41f5-a30f-a58921a69b79',
  };

  it('walks the lockfile through workspace links, peers and aliases', () => {
    const closure = closureOf(lock, 'apps/desktop');
    expect([...closure.packages.keys()].sort()).toEqual([
      'react-dom@19.0.0',
      'react@19.0.0',
      'scheduler@0.25.0',
      'string-width@4.2.3',
      'vite@7.0.0',
      'zod@4.0.0',
    ]);
    expect(closure.importers).toEqual(['apps/desktop', 'packages/core']);
    expect([...(closure.edges.get('react-dom@19.0.0') ?? [])].sort()).toEqual([
      'react@19.0.0',
      'scheduler@0.25.0',
    ]);
    expect(() => parseLockfile("lockfileVersion: '6.0'\nimporters: {}\n")).toThrow(/format 9/);
  });

  it('writes CycloneDX 1.6 with shipped packages required and build tools excluded', () => {
    const bom = buildSbom(input) as {
      bomFormat: string;
      specVersion: string;
      metadata: { component: { 'bom-ref': string; name: string; version: string } };
      components: {
        'bom-ref': string;
        name: string;
        scope: string;
        purl?: string;
        hashes?: { alg: string; content: string }[];
        licenses?: unknown[];
        externalReferences?: { type: string; url: string }[];
      }[];
      dependencies: { ref: string; dependsOn: string[] }[];
    };
    expect(bom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.6', version: 1 });
    expect(bom.metadata.component).toMatchObject({ name: 'Joinery', version: '1.2.3' });
    const byName = new Map(bom.components.map((c) => [c.name, c]));
    expect(byName.get('react')).toMatchObject({
      scope: 'required',
      purl: 'pkg:npm/react@19.0.0',
      licenses: [{ license: { id: 'MIT' } }],
      externalReferences: [{ type: 'website', url: 'https://react.dev/' }],
    });
    expect(byName.get('vite')).toMatchObject({
      scope: 'excluded',
      licenses: [{ license: { id: 'MIT' } }],
    });
    expect(byName.get('string-width')).toMatchObject({
      scope: 'excluded',
      externalReferences: [
        { type: 'distribution', url: 'https://registry.example/string-width-4.2.3.tgz' },
      ],
    });
    expect(byName.get('string-width')?.licenses).toBeUndefined();
    expect(byName.get('@joinery/core')).toMatchObject({ scope: 'required' });
    expect(byName.get('scheduler')?.hashes).toEqual([{ alg: 'SHA-1', content: '082082' }]);

    // Every reference resolves, and every component appears in the graph.
    const refs = new Set([
      bom.metadata.component['bom-ref'],
      ...bom.components.map((c) => c['bom-ref']),
    ]);
    expect(refs.size).toBe(bom.components.length + 1);
    expect(new Set(bom.dependencies.map((d) => d.ref))).toEqual(refs);
    for (const d of bom.dependencies)
      for (const target of d.dependsOn) expect(refs.has(target)).toBe(true);
    const app = bom.dependencies.find((d) => d.ref === bom.metadata.component['bom-ref']);
    expect(app?.dependsOn).toContain('workspace:@joinery/core@0.0.0');
  });

  it('names a bundled asset as a generic component, outside the lockfile', () => {
    const bom = buildSbom({
      ...input,
      shipped: [
        ...input.shipped,
        {
          name: 'Rec Mono (Recursive)',
          version: '1.085',
          licence: 'OFL-1.1',
          homepage: 'https://github.com/arrowtype/recursive',
          source: 'asset' as const,
        },
      ],
    }) as {
      components: { name: string; 'bom-ref': string }[];
      dependencies: { ref: string }[];
    };
    const font = bom.components.find((c) => c.name === 'Rec Mono (Recursive)');
    expect(font).toMatchObject({
      'bom-ref': 'pkg:generic/rec%20mono%20(recursive)@1.085',
      scope: 'required',
      licenses: [{ license: { id: 'OFL-1.1' } }],
      externalReferences: [{ type: 'website', url: 'https://github.com/arrowtype/recursive' }],
    });
    expect(bom.dependencies.map((d) => d.ref)).toContain(font!['bom-ref']);
  });

  it('refuses a shipped package the lockfile does not explain', () => {
    expect(() =>
      buildSbom({
        ...input,
        shipped: [...input.shipped, { name: 'ghost', version: '1.0.0', licence: 'MIT' }],
      }),
    ).toThrow(/ghost@1.0.0/);
  });

  it('formats licences, purls and hashes', () => {
    expect(cdxLicences('MIT')).toEqual([{ license: { id: 'MIT' } }]);
    expect(cdxLicences('(MIT OR Apache-2.0)')).toEqual([{ expression: '(MIT OR Apache-2.0)' }]);
    expect(cdxLicences('SEE LICENSE IN LICENSE.md')).toEqual([
      { license: { name: 'SEE LICENSE IN LICENSE.md' } },
    ]);
    expect(cdxLicences('UNKNOWN')).toBeUndefined();
    expect(purlOf({ name: '@scope/pkg', version: '1.0.0-beta.1' })).toBe(
      'pkg:npm/%40scope/pkg@1.0.0-beta.1',
    );
    expect(cdxHash('sha512-AAAA')).toEqual({ alg: 'SHA-512', content: '000000' });
    expect(cdxHash('md5-AAAA')).toBeUndefined();
  });

  it('covers the real lockfile of the desktop app', () => {
    const real = parseLockfile(
      readFileSync(resolve(import.meta.dirname, '../../../pnpm-lock.yaml'), 'utf8'),
    );
    const closure = closureOf(real, 'apps/desktop');
    expect(closure.packages.has(`electron-updater@${readVersion('electron-updater')}`)).toBe(true);
    expect(closure.importers).toContain('packages/ipc');
  });
});

function readVersion(name: string): string {
  const pkg = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../node_modules', name, 'package.json'), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

describe('the staged rollout', () => {
  const LATEST = `version: 1.2.0
files:
  - url: Joinery-Setup-1.2.0.exe
    sha512: abc==
    size: 100
path: Joinery-Setup-1.2.0.exe
sha512: abc==
releaseDate: '2026-09-29T21:00:00.000Z'
`;

  it('sets, changes and removes the staging percentage', () => {
    const twenty = setStagingPercentage(LATEST, 20);
    expect(load(twenty)).toMatchObject({ version: '1.2.0', stagingPercentage: 20 });
    expect(twenty.startsWith(LATEST.trimEnd())).toBe(true);
    const fifty = setStagingPercentage(twenty, 50);
    expect(fifty.match(/stagingPercentage/g)).toHaveLength(1);
    expect(load(fifty)).toMatchObject({ stagingPercentage: 50 });
    expect(setStagingPercentage(fifty, 0)).toContain('stagingPercentage: 0');
    expect(setStagingPercentage(fifty, 100)).toBe(LATEST);
  });

  it('refuses bad percentages and files that are not update metadata', () => {
    for (const bad of [-1, 101, 12.5, Number.NaN]) {
      expect(() => setStagingPercentage(LATEST, bad)).toThrow(RangeError);
    }
    expect(() => setStagingPercentage('name: x\n', 10)).toThrow(/update metadata/);
  });

  it('finds the metadata files in a directory', () => {
    const dir = join(scratch, 'dist');
    mkdirSync(dir, { recursive: true });
    for (const name of ['latest.yml', 'latest-linux-arm64.yml', 'builder-debug.yml', 'a.exe']) {
      writeFileSync(join(dir, name), LATEST);
    }
    expect(metadataFiles([dir])).toEqual([
      join(dir, 'latest-linux-arm64.yml'),
      join(dir, 'latest.yml'),
    ]);
    expect(() => metadataFiles([join(dir, 'builder-debug.yml')])).toThrow(/not update metadata/);
  });

  it('knows the metadata file names', () => {
    for (const name of [
      'latest.yml',
      'latest-mac.yml',
      'latest-linux.yml',
      'latest-linux-arm64.yml',
      'beta.yml',
      'beta-linux-arm64.yml',
    ]) {
      expect(UPDATE_METADATA.test(name)).toBe(true);
    }
    for (const name of ['builder-debug.yml', 'app-update.yml', 'latest.yaml']) {
      expect(UPDATE_METADATA.test(name)).toBe(false);
    }
  });
});
