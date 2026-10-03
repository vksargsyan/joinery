import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { UpdateChannel } from '@querybara/ipc';
import { NsisUpdater } from 'electron-updater';
import { afterAll, describe, expect, it } from 'vitest';

import { setStagingPercentage } from '../scripts/rollout';
import { updaterOptions } from '../src/main/update-policy';
import { configureChannel } from '../src/main/updates';

/**
 * Channels and staged rollout against electron-updater itself (spec §20): a real updater and its
 * GitHub provider, over a fake GitHub (the releases feed, `releases/latest` and each release's
 * `latest.yml`, which is what electron-builder writes for the github provider whatever the
 * version) and a fake app. Nothing is downloaded. These pin the behaviour `updaterOptions`,
 * `configureChannel` and scripts/rollout.ts rely on, so an electron-updater upgrade that
 * changes it fails here.
 */

const OWNER = 'vksargsyan';
const REPO = 'querybara';

interface Release {
  readonly version: string;
  readonly prerelease?: boolean;
  /** The staged rollout, written into latest.yml by scripts/rollout.ts. */
  readonly rollout?: number;
}

/** GitHub as electron-updater's GitHub provider reads it; releases newest first. */
function fakeGitHub(releases: readonly Release[]) {
  const requests: string[] = [];
  const entries = releases.map(
    ({ version }) => `
  <entry>
    <id>tag:github.com,2008:Repository/1/v${version}</id>
    <link rel="alternate" type="text/html" href="https://github.com/${OWNER}/${REPO}/releases/tag/v${version}"/>
    <title>Querybara ${version}</title>
    <content type="html">Notes for ${version}</content>
  </entry>`,
  );
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/${OWNER}/${REPO}/releases</id>
  <title>Release notes from ${REPO}</title>${entries.join('')}
</feed>`;
  const latestStable = releases.find((release) => !release.prerelease);
  const metadata = (release: Release): string => {
    const installer = `Querybara-Setup-${release.version}.exe`;
    const text = [
      `version: ${release.version}`,
      'files:',
      `  - url: ${installer}`,
      '    sha512: AAAA',
      '    size: 1',
      `path: ${installer}`,
      'sha512: AAAA',
      "releaseDate: '2026-09-01T00:00:00.000Z'",
      '',
    ].join('\n');
    return release.rollout === undefined ? text : setStagingPercentage(text, release.rollout);
  };
  const executor = {
    request: async (options: {
      protocol?: string | null;
      hostname?: string | null;
      path?: string | null;
    }): Promise<string | null> => {
      const url = new URL(`${options.protocol ?? 'https:'}//${options.hostname}${options.path}`);
      requests.push(url.pathname);
      const base = `/${OWNER}/${REPO}/releases`;
      if (url.pathname === `${base}.atom`) return feed;
      if (url.pathname === `${base}/latest`) {
        if (!latestStable) throw new Error('404 Not Found');
        return JSON.stringify({ tag_name: `v${latestStable.version}` });
      }
      const download = new RegExp(`^${base}/download/v([^/]+)/([^/]+)$`).exec(url.pathname);
      const release = releases.find((candidate) => candidate.version === download?.[1]);
      if (release && download?.[2] === 'latest.yml') return metadata(release);
      throw new Error(`404 Not Found: ${url.pathname}`);
    },
  };
  return { executor, requests };
}

/** A staging id (the `.updaterId` each install keeps) that falls at `fraction` of the range. */
function stagingId(fraction: number): string {
  const tail = Math.round(fraction * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  return `12345678-1234-4123-8123-1234${tail}`;
}

const scratch = mkdtempSync(join(tmpdir(), 'querybara-update-feed-'));
let installs = 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Runs one check of an installed `version` on `channel` against `releases`. */
async function check(options: {
  readonly version: string;
  readonly channel: UpdateChannel;
  readonly releases: readonly Release[];
  readonly staging?: number;
}): Promise<{ offered: string | undefined; latest: string | undefined; requests: string[] }> {
  const userData = join(scratch, `install-${++installs}`);
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, '.updaterId'), stagingId(options.staging ?? 0.5));
  const github = fakeGitHub(options.releases);
  const app = {
    version: options.version,
    name: 'Querybara',
    isPackaged: true,
    appUpdateConfigPath: join(userData, 'app-update.yml'),
    userDataPath: userData,
    baseCachePath: userData,
    whenReady: () => Promise.resolve(),
    relaunch: () => undefined,
    quit: () => undefined,
    onQuit: () => undefined,
  };
  const updater = new NsisUpdater(null, app);
  updater.logger = null;
  updater.autoDownload = false;
  // electron-updater's own test hooks: the HTTP client and the platform of the channel files.
  Object.assign(updater, {
    httpExecutor: github.executor,
    _testOnlyOptions: { platform: 'win32' },
  });
  updater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO });
  configureChannel(updater, updaterOptions(options.channel));
  const result = await updater.checkForUpdates();
  return {
    offered: result?.isUpdateAvailable ? result.updateInfo.version : undefined,
    latest: result?.updateInfo.version,
    requests: github.requests,
  };
}

describe('channels', () => {
  const releases: Release[] = [
    { version: '1.3.0-beta.1', prerelease: true },
    { version: '1.2.0' },
    { version: '1.1.0' },
  ];

  it('offers stable installs the latest stable release, never a pre-release', async () => {
    const stable = await check({ version: '1.1.0', channel: 'stable', releases });
    expect(stable).toMatchObject({ offered: '1.2.0', latest: '1.2.0' });
    expect(stable.requests.some((path) => path.includes('beta'))).toBe(false);
  });

  it('offers beta installs the newest release of either kind', async () => {
    const beta = await check({ version: '1.1.0', channel: 'beta', releases });
    expect(beta.offered).toBe('1.3.0-beta.1');
    // A beta release carries latest.yml: beta.yml is tried first, then latest.yml.
    expect(beta.requests.filter((path) => path.includes('/download/'))).toEqual([
      `/${OWNER}/${REPO}/releases/download/v1.3.0-beta.1/beta.yml`,
      `/${OWNER}/${REPO}/releases/download/v1.3.0-beta.1/latest.yml`,
    ]);

    const released = await check({
      version: '1.3.0-beta.1',
      channel: 'beta',
      releases: [{ version: '1.3.0' }, ...releases],
    });
    expect(released.offered).toBe('1.3.0');
  });

  it('never downgrades a beta install whose user went back to stable', async () => {
    const back = await check({
      version: '1.3.0-beta.1',
      channel: 'stable',
      releases: [{ version: '1.3.0-beta.2', prerelease: true }, ...releases],
    });
    expect(back).toMatchObject({ offered: undefined, latest: '1.2.0' });

    const later = await check({
      version: '1.3.0-beta.1',
      channel: 'stable',
      releases: [{ version: '1.3.0' }, ...releases],
    });
    expect(later.offered).toBe('1.3.0');
  });
});

describe('staged rollout', () => {
  const at = (rollout: number | undefined, staging: number) =>
    check({
      version: '1.1.0',
      channel: 'stable',
      releases: [{ version: '1.2.0', ...(rollout === undefined ? {} : { rollout }) }],
      staging,
    }).then((result) => result.offered);

  it('offers a release to the installs whose staging id falls within the percentage', async () => {
    expect(await at(20, 0.1)).toBe('1.2.0');
    expect(await at(20, 0.3)).toBeUndefined();
    // Raising it keeps the machines already in and adds more.
    expect(await at(50, 0.1)).toBe('1.2.0');
    expect(await at(50, 0.3)).toBe('1.2.0');
    expect(await at(50, 0.6)).toBeUndefined();
  });

  it('offers it to nobody at 0 and to everyone at 100 (no field)', async () => {
    expect(await at(0, 0.000001)).toBeUndefined();
    expect(await at(100, 0.999)).toBe('1.2.0');
    expect(await at(undefined, 0.999)).toBe('1.2.0');
  });
});
