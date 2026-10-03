import { describe, expect, it } from 'vitest';

import {
  DISABLE_UPDATES_ENV,
  NO_POLICY,
  detectInstallKind,
  effectiveChannel,
  installsOnQuit,
  isAllowedUpdateUrl,
  mergePolicies,
  parseManagedPreferences,
  parsePolicyFile,
  parseRegistryPolicy,
  parseUpdateFeed,
  policyFromEnv,
  policyLocations,
  readUpdatePolicy,
  releaseNotesUrl,
  updateAvailability,
  updaterOptions,
  type PolicyReaders,
  type UpdateFeed,
} from '../src/main/update-policy';

/**
 * The rules of auto-update (spec §20): the administrator's switch for managed fleets from every
 * platform's policy store, the installation kind, the feed a release build carries, and which
 * of them keeps the updater off. No network and no Electron.
 */

const FEED: UpdateFeed = {
  owner: 'vksargsyan',
  repo: 'querybara',
  publisherNames: ['Querybara Ltd'],
};

describe('the policy switch', () => {
  it('takes the environment variable only as a way to turn updates off', () => {
    for (const value of ['1', 'true', 'YES', ' on ']) {
      expect(policyFromEnv({ [DISABLE_UPDATES_ENV]: value })).toEqual({
        source: DISABLE_UPDATES_ENV,
        disabled: true,
      });
    }
    for (const value of ['0', 'false', '', 'off', undefined]) {
      expect(policyFromEnv({ [DISABLE_UPDATES_ENV]: value }).disabled).toBeUndefined();
    }
  });

  it('reads a policy file, and a file it cannot read turns updates off', () => {
    expect(parsePolicyFile('{"disableUpdates": true}', '/etc/querybara/policy.json')).toEqual({
      source: '/etc/querybara/policy.json',
      disabled: true,
    });
    expect(parsePolicyFile('{"updateChannel": "stable", "future": 1}', 'p')).toEqual({
      source: 'p',
      channel: 'stable',
    });
    expect(parsePolicyFile('{"disableUpdates": false}', 'p')).toEqual({
      source: 'p',
      disabled: false,
    });
    for (const broken of ['{', '[]', '{"disableUpdates": "yes"}', '{"updateChannel": "nightly"}']) {
      expect(parsePolicyFile(broken, 'p')).toEqual({ source: 'p (unreadable)', disabled: true });
    }
  });

  it('reads the Group Policy registry values', () => {
    const output = [
      '',
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Querybara',
      '    DisableUpdates    REG_DWORD    0x1',
      '    UpdateChannel    REG_SZ    Beta',
      '',
    ].join('\r\n');
    expect(parseRegistryPolicy(output, 'HKLM')).toEqual({
      source: 'HKLM',
      disabled: true,
      channel: 'beta',
    });
    expect(parseRegistryPolicy('    DisableUpdates    REG_DWORD    0x0\n', 'HKLM')).toEqual({
      source: 'HKLM',
      disabled: false,
    });
    expect(parseRegistryPolicy('    DisableUpdates    REG_SZ    true\n', 'HKLM').disabled).toBe(
      true,
    );
    expect(parseRegistryPolicy('    UpdateChannel    REG_SZ    nightly\n', 'HKLM')).toEqual({
      source: 'HKLM',
    });
  });

  it('reads macOS managed preferences', () => {
    expect(parseManagedPreferences({ DisableUpdates: true, UpdateChannel: 'stable' }, 'm')).toEqual(
      { source: 'm', disabled: true, channel: 'stable' },
    );
    expect(parseManagedPreferences({ Other: 1 }, 'm')).toEqual({ source: 'm' });
    expect(parseManagedPreferences(undefined, 'm')).toEqual({ source: 'm', disabled: true });
  });

  it('merges sources: any can turn updates off, the strongest names the channel', () => {
    expect(mergePolicies([])).toEqual(NO_POLICY);
    const merged = mergePolicies([
      { source: 'registry', channel: 'stable' },
      { source: 'file', disabled: false, channel: 'beta' },
      { source: 'env', disabled: true },
      { source: 'nothing' },
    ]);
    expect(merged).toEqual({
      disabled: true,
      channel: 'stable',
      sources: ['registry', 'file', 'env'],
    });
  });

  it('knows each platform’s machine-wide locations', () => {
    expect(policyLocations('linux', {})).toEqual({ file: '/etc/querybara/policy.json' });
    expect(policyLocations('darwin', {})).toEqual({
      file: '/Library/Application Support/Querybara/policy.json',
      managedPreferences: '/Library/Managed Preferences/com.querybara.desktop.plist',
    });
    // No policy file on Windows: standard users can create folders in %ProgramData%.
    expect(policyLocations('win32', { SystemRoot: 'D:\\WINDOWS' })).toEqual({
      registryKey: 'HKLM\\SOFTWARE\\Policies\\Querybara',
      regExe: 'D:\\WINDOWS\\System32\\reg.exe',
    });
  });

  it('reads every source of the platform, strongest first', async () => {
    const calls: string[] = [];
    const readers = (
      files: Record<string, string>,
      tools: Record<string, string>,
    ): PolicyReaders => ({
      readFile: async (path) => {
        calls.push(`read ${path}`);
        return files[path];
      },
      run: async (file, args) => {
        calls.push(`run ${file} ${args.join(' ')}`);
        return tools[file];
      },
    });

    const regExe = 'C:\\Windows\\System32\\reg.exe';
    const windows = await readUpdatePolicy({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', [DISABLE_UPDATES_ENV]: '1' },
      readers: readers(
        { 'C:\\ProgramData\\Querybara\\policy.json': '{"updateChannel":"beta"}' },
        { [regExe]: '    UpdateChannel    REG_SZ    stable\n' },
      ),
    });
    expect(windows).toEqual({
      disabled: true,
      channel: 'stable',
      sources: ['HKLM\\SOFTWARE\\Policies\\Querybara', DISABLE_UPDATES_ENV],
    });
    expect(calls).toEqual([`run ${regExe} query HKLM\\SOFTWARE\\Policies\\Querybara`]);

    const plist = '/Library/Managed Preferences/com.querybara.desktop.plist';
    const mac = await readUpdatePolicy({
      platform: 'darwin',
      env: {},
      readers: readers({ [plist]: 'bplist00' }, { '/usr/bin/plutil': '{"DisableUpdates":true}' }),
    });
    expect(mac).toMatchObject({ disabled: true, sources: [plist] });

    const linux = await readUpdatePolicy({
      platform: 'linux',
      env: { [DISABLE_UPDATES_ENV]: '1' },
      readers: readers({}, {}),
    });
    expect(linux).toEqual({ disabled: true, sources: [DISABLE_UPDATES_ENV] });

    const none = await readUpdatePolicy({ platform: 'linux', env: {}, readers: readers({}, {}) });
    expect(none).toEqual(NO_POLICY);
  });
});

describe('the installation', () => {
  const detect = (input: {
    platform: string;
    execPath?: string;
    env?: Record<string, string>;
    files?: Record<string, string>;
  }) =>
    detectInstallKind({
      platform: input.platform,
      execPath: input.execPath ?? '/opt/Querybara/querybara',
      resourcesPath: '/opt/Querybara/resources',
      env: input.env ?? {},
      exists: (path) => path in (input.files ?? {}),
      readText: (path) => input.files?.[path],
    });

  it('tells the NSIS install from the MSI and the zip by its uninstaller', () => {
    const execPath = 'C:\\Users\\a\\AppData\\Local\\Programs\\querybara\\querybara.exe';
    expect(
      detect({
        platform: 'win32',
        execPath,
        files: { 'C:\\Users\\a\\AppData\\Local\\Programs\\querybara\\Uninstall querybara.exe': '' },
      }),
    ).toBe('nsis');
    expect(
      detect({ platform: 'win32', execPath: 'C:\\Program Files\\Querybara\\querybara.exe' }),
    ).toBe('windows-other');
  });

  it('finds AppImages by their runtime and packages by their marker', () => {
    expect(detect({ platform: 'darwin' })).toBe('mac-app');
    expect(
      detect({
        platform: 'linux',
        env: { APPIMAGE: '/home/a/Querybara.AppImage' },
        files: { '/opt/Querybara/resources/package-type': 'rpm' },
      }),
    ).toBe('appimage');
    expect(
      detect({ platform: 'linux', files: { '/opt/Querybara/resources/package-type': 'deb\n' } }),
    ).toBe('deb');
    expect(
      detect({ platform: 'linux', files: { '/opt/Querybara/resources/package-type': 'rpm' } }),
    ).toBe('rpm');
    expect(
      detect({ platform: 'linux', files: { '/opt/Querybara/resources/package-type': 'pacman' } }),
    ).toBe('linux-other');
    expect(detect({ platform: 'linux' })).toBe('linux-other');
  });

  it('installs on quit except where installing asks for a password', () => {
    for (const install of ['mac-app', 'nsis', 'appimage'] as const) {
      expect(installsOnQuit(install)).toBe(true);
    }
    expect(installsOnQuit('deb')).toBe(false);
    expect(installsOnQuit('rpm')).toBe(false);
  });
});

describe('the feed and whether updates run', () => {
  it('reads the GitHub feed electron-builder writes', () => {
    expect(
      parseUpdateFeed({
        owner: 'vksargsyan',
        repo: 'querybara',
        provider: 'github',
        publisherName: ['Querybara Ltd'],
        updaterCacheDirName: 'x',
      }),
    ).toEqual(FEED);
    expect(
      parseUpdateFeed({ owner: 'o', repo: 'r', provider: 'github', publisherName: 'P' }),
    ).toEqual({
      owner: 'o',
      repo: 'r',
      publisherNames: ['P'],
    });
    expect(parseUpdateFeed({ provider: 'generic', url: 'https://example.com' })).toBeUndefined();
    expect(parseUpdateFeed({ provider: 'github', owner: '../x', repo: 'r' })).toBeUndefined();
    expect(parseUpdateFeed(null)).toBeUndefined();
  });

  type Input = Parameters<typeof updateAvailability>[0];
  const base: Input = {
    packaged: true,
    policy: NO_POLICY,
    feed: FEED,
    platform: 'win32',
    install: 'nsis',
  };

  it('runs a signed release build installed by a known installer', () => {
    expect(updateAvailability(base)).toEqual({ enabled: true });
    expect(
      updateAvailability({
        ...base,
        platform: 'linux',
        install: 'appimage',
        feed: { ...FEED, publisherNames: [] },
      }),
    ).toEqual({ enabled: true });
    expect(updateAvailability({ ...base, platform: 'darwin', install: 'mac-app' })).toEqual({
      enabled: true,
    });
  });

  it('stays off, with the first reason that applies', () => {
    const off = (patch: Partial<Input>) => updateAvailability({ ...base, ...patch });
    expect(off({ packaged: false, policy: { disabled: true, sources: [] } })).toEqual({
      enabled: false,
      reason: 'development',
    });
    expect(off({ policy: { disabled: true, sources: ['env'] }, feed: undefined })).toEqual({
      enabled: false,
      reason: 'policy',
    });
    expect(off({ feed: undefined })).toEqual({ enabled: false, reason: 'test-build' });
    expect(off({ feed: { ...FEED, publisherNames: [] } })).toEqual({
      enabled: false,
      reason: 'unsigned',
    });
    expect(off({ install: 'windows-other' })).toEqual({
      enabled: false,
      reason: 'unsupported-install',
    });
    expect(off({ platform: 'linux', install: 'linux-other' })).toEqual({
      enabled: false,
      reason: 'unsupported-install',
    });
  });
});

describe('channels and URLs', () => {
  it('lets a policy pin the channel', () => {
    expect(effectiveChannel('beta', NO_POLICY)).toBe('beta');
    expect(effectiveChannel('beta', { disabled: false, channel: 'stable', sources: ['p'] })).toBe(
      'stable',
    );
  });

  it('maps channels to electron-updater options', () => {
    expect(updaterOptions('stable')).toEqual({ channel: 'latest', allowPrerelease: false });
    expect(updaterOptions('beta')).toEqual({ channel: 'beta', allowPrerelease: true });
  });

  it('lets the updater session reach GitHub over https only', () => {
    for (const url of [
      'https://github.com/vksargsyan/querybara/releases.atom',
      'https://api.github.com/repos/x/y/releases/latest',
      'https://objects.githubusercontent.com/github-production-release-asset/1',
      'https://release-assets.githubusercontent.com/x',
    ]) {
      expect(isAllowedUpdateUrl(url)).toBe(true);
    }
    for (const url of [
      'http://github.com/x',
      'https://github.com.evil.example/x',
      'https://evilgithub.com/x',
      'https://user:pass@github.com/x',
      'file:///etc/passwd',
      'not a url',
    ]) {
      expect(isAllowedUpdateUrl(url)).toBe(false);
    }
  });

  it('links a version’s release notes', () => {
    expect(releaseNotesUrl(FEED, '1.2.0-beta.1')).toBe(
      'https://github.com/vksargsyan/querybara/releases/tag/v1.2.0-beta.1',
    );
  });
});
