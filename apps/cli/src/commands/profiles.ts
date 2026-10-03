import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ENGINES,
  newId,
  secretRefsOf,
  type ColumnMeta,
  type ConnectionProfile,
  type Environment,
  type SecretPolicy,
  type SecretRef,
  type TlsMode,
} from '@querybara/core';
import {
  exportProfiles,
  importProfiles,
  parseConnectionUri,
  type ExportedFolder,
  type Store,
  type StoredProfile,
} from '@querybara/storage';

import { CliError, EXIT, type ExitCode } from '../errors';
import { TableWriter } from '../output/formats';
import { plural, writeLine, type Runtime } from '../runtime';
import { confirmOperation } from '../safety';
import { describeEndpoint, findProfile, isConnectionUri, passwordEnvName } from '../target';

/**
 * `querybara profiles ...`: the local store's connection profiles, shared with the desktop app.
 * Nothing here prints a secret value: `show` reports whether each secret is saved and readable,
 * and exports carry secrets only inside the passphrase-encrypted file.
 */

// ---------------------------------------------------------------------------------------------
// list / show

export async function listProfiles(
  runtime: Runtime,
  options: { json: boolean },
): Promise<ExitCode> {
  const store = runtime.store.open({ create: false });
  const profiles = store?.profiles.list() ?? [];
  if (options.json) {
    await writeLine(
      runtime,
      JSON.stringify(
        profiles.map((p) => profileJson(store!, p)),
        null,
        2,
      ),
    );
    return EXIT.ok;
  }
  if (profiles.length === 0) {
    runtime.reporter.info(`No profiles in ${runtime.store.location.path}`);
    return EXIT.ok;
  }
  const folders = folderPaths(store!);
  const names = ['name', 'engine', 'endpoint', 'database', 'user', 'environment', 'folder', 'id'];
  const columns: ColumnMeta[] = names.map((name) => ({ name, nativeType: 'text', kind: 'string' }));
  const rows = profiles.map((p) => [
    p.name,
    ENGINES[p.engine].displayName,
    describeEndpoint(p),
    p.options.defaultDatabase ?? '',
    userOf(p) ?? '',
    `${p.presentation.environment}${p.presentation.readOnly ? ' (read-only)' : ''}`,
    p.presentation.folderId ? (folders.get(p.presentation.folderId) ?? '') : '',
    p.id,
  ]);
  const writer = new TableWriter(runtime.stdout, {
    ...(runtime.stdout.isTTY && runtime.stdout.columns ? { width: runtime.stdout.columns } : {}),
    maxColumnWidth: 60,
  });
  await writer.begin(columns);
  await writer.rows(
    names.map((_n, c) => rows.map((row) => row[c] ?? '')),
    rows.length,
  );
  await writer.end();
  return EXIT.ok;
}

export async function showProfile(
  runtime: Runtime,
  spec: string,
  options: { json: boolean },
): Promise<ExitCode> {
  const store = requireExistingStore(runtime, spec);
  const profile = findProfile(store, spec);
  if (options.json) {
    await writeLine(runtime, JSON.stringify(profileJson(store, profile), null, 2));
    return EXIT.ok;
  }
  const p = profile.presentation;
  const flags = [p.readOnly ? 'read-only' : '', p.confirmWrites ? 'confirms writes' : '']
    .filter(Boolean)
    .join(', ');
  const tls = profile.tls;
  const lines: [string, string][] = [
    ['Name', profile.name],
    ['ID', profile.id],
    ['Engine', ENGINES[profile.engine].displayName],
    ['Endpoint', describeEndpoint(profile)],
    ['Database', profile.options.defaultDatabase ?? '(server default)'],
    ['User', userOf(profile) ?? '(none)'],
    ['Auth', profile.auth.method],
    [
      'TLS',
      [tls.mode, tls.caPath ? `CA ${tls.caPath}` : '', tls.certPath ? `cert ${tls.certPath}` : '']
        .filter(Boolean)
        .join(', '),
    ],
    ['Environment', `${p.environment}${flags ? ` (${flags})` : ''}`],
    ['Folder', p.folderId ? (folderPaths(store).get(p.folderId) ?? p.folderId) : '(root)'],
    ['Tags', p.tags.length > 0 ? p.tags.join(', ') : '(none)'],
  ];
  if (profile.ssh)
    lines.push(['SSH', profile.ssh.hops.map((h) => `${h.user}@${h.host}:${h.port}`).join(' → ')]);
  if (profile.proxy) {
    const { kind, host, port, user } = profile.proxy;
    lines.push(['Proxy', `${kind}://${user ? `${user}@` : ''}${host}:${port}`]);
  }
  for (const secret of secretStatus(store, profile)) {
    lines.push([secret.label, describeSecret(secret)]);
  }
  if (profile.auth.method === 'password') {
    lines.push(['Password env', `${passwordEnvName(profile.name)} or QUERYBARA_PASSWORD`]);
  }
  lines.push(['Created', profile.createdAt], ['Updated', profile.updatedAt]);
  const width = Math.max(...lines.map(([label]) => label.length)) + 2;
  for (const [label, value] of lines)
    await writeLine(runtime, `${`${label}:`.padEnd(width)}${value}`);
  return EXIT.ok;
}

interface SecretInfo {
  readonly label: string;
  readonly ref: SecretRef;
  readonly status: 'available' | 'missing' | 'unreadable';
}

function secretStatus(store: Store, profile: ConnectionProfile): SecretInfo[] {
  const resolved = store.secrets.resolve(profile);
  const unreadable = new Set(resolved.unreadable.map((ref) => ref.id));
  return secretRefsOf(profile).map((ref) => ({
    label: secretLabel(profile, ref),
    ref,
    status:
      resolved.secrets[ref.id] !== undefined
        ? 'available'
        : unreadable.has(ref.id)
          ? 'unreadable'
          : 'missing',
  }));
}

function secretLabel(profile: ConnectionProfile, ref: SecretRef): string {
  const auth = profile.auth;
  if (auth.method === 'password' && auth.password?.id === ref.id) return 'Password';
  if (profile.tls.keyPassphrase?.id === ref.id) return 'TLS key passphrase';
  if (profile.proxy?.password?.id === ref.id) return 'Proxy password';
  if (auth.method === 'apiKey' || auth.method === 'bearer') return 'Token';
  return 'SSH secret';
}

function describeSecret(secret: SecretInfo): string {
  switch (secret.ref.policy) {
    case 'ask':
      return 'asked every time';
    case 'session':
      return 'remembered per app session (asked here)';
    case 'save':
      return secret.status === 'available'
        ? 'saved (readable here)'
        : secret.status === 'unreadable'
          ? "saved, but not readable here (sealed by the desktop app's keychain, or QUERYBARA_PASSPHRASE is not set or differs)"
          : 'not saved';
  }
}

/** The profile as JSON, with secret status but never secret values. */
function profileJson(store: Store, profile: StoredProfile): Record<string, unknown> {
  return {
    ...profile,
    secrets: secretStatus(store, profile).map((s) => ({
      id: s.ref.id,
      kind: s.label,
      policy: s.ref.policy,
      status: s.status,
    })),
  };
}

function userOf(profile: ConnectionProfile): string | undefined {
  return 'user' in profile.auth ? profile.auth.user : undefined;
}

/** Folder id → "Parent/Child" path. */
function folderPaths(store: Store): Map<string, string> {
  const folders = new Map(store.folders.list().map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  const pathOf = (id: string, seen: Set<string>): string => {
    const known = paths.get(id);
    if (known !== undefined) return known;
    const folder = folders.get(id);
    if (!folder || seen.has(id)) return '';
    seen.add(id);
    const parent = folder.parentId ? pathOf(folder.parentId, seen) : '';
    const path = parent ? `${parent}/${folder.name}` : folder.name;
    paths.set(id, path);
    return path;
  };
  for (const id of folders.keys()) pathOf(id, new Set());
  return paths;
}

function requireExistingStore(runtime: Runtime, spec: string): Store {
  const store = runtime.store.open({ create: false });
  if (!store) {
    throw new CliError(`No profile named "${spec}"`, {
      code: 'NOT_FOUND',
      hint: `There is no local store at ${runtime.store.location.path} yet`,
    });
  }
  return store;
}

// ---------------------------------------------------------------------------------------------
// add / import-uri

export interface AddProfileOptions {
  readonly name?: string;
  readonly environment?: Environment;
  /** Folder id or path such as "Team/Prod" (created when missing). */
  readonly folder?: string;
  readonly passwordPolicy?: SecretPolicy;
  readonly readOnly?: boolean;
  readonly confirmWrites?: boolean;
  readonly tls?: TlsMode;
  /** For mysql:// URIs of MariaDB servers. */
  readonly engine?: 'mysql' | 'mariadb';
  readonly tags: readonly string[];
  /** Replace a profile with the same name. */
  readonly replace?: boolean;
}

/**
 * Saves a profile from a URI. The URI's password is saved only under the `save` policy, sealed
 * with QUERYBARA_PASSPHRASE; without a passphrase the profile asks for it instead. A URI without
 * a password gets no password reference unless --password-policy asks for one.
 */
export async function addProfile(
  runtime: Runtime,
  uri: string,
  options: AddProfileOptions,
): Promise<ExitCode> {
  if (!isConnectionUri(uri)) {
    throw new CliError('Expected a connection URI such as postgres://user@host:5432/db', {
      hint: 'The password may be left out of the URI; pass --password-policy save to be asked for it',
    });
  }
  const parsed = parseConnectionUri(uri, {
    ...(options.engine !== undefined ? { engine: options.engine } : {}),
    ...(options.name !== undefined ? { name: options.name } : {}),
  });
  for (const param of parsed.ignoredParams)
    runtime.reporter.warn(`ignored URI parameter: ${param}`);
  const store = runtime.store.require();
  const draft = parsed.profile;
  const name = options.name ?? draft.name;

  const sameName = store.profiles.list().filter((p) => p.name.toLowerCase() === name.toLowerCase());
  if (sameName.length > 0 && !options.replace) {
    throw new CliError(`A profile named "${sameName[0]!.name}" already exists`, {
      hint: 'Pass --replace to overwrite it, or choose another --name',
    });
  }
  if (sameName.length > 1) {
    throw new CliError(`${sameName.length} profiles are named "${name}"; remove one first`);
  }
  const existing = sameName[0];

  const canSave = store.secrets.canSave();
  let policy = options.passwordPolicy;
  if (policy === undefined && parsed.password !== undefined) {
    policy = canSave ? 'save' : 'ask';
    if (!canSave) {
      runtime.reporter.warn(
        'The password in the URI was not saved: set QUERYBARA_PASSPHRASE to save passwords sealed with it. The profile asks for the password instead.',
      );
    }
  }
  if (policy === 'save' && !canSave) {
    throw new CliError('Cannot save the password without QUERYBARA_PASSPHRASE', {
      code: 'NOT_SUPPORTED',
      hint: 'Set QUERYBARA_PASSPHRASE to seal saved passwords, or pass --password-policy ask',
    });
  }
  let password: string | undefined;
  if (policy === 'save') {
    password = parsed.password ?? runtime.ctx.env['QUERYBARA_PASSWORD'];
    if (password === undefined) {
      if (!runtime.ctx.prompter.interactive) {
        throw new CliError('No password to save', {
          hint: 'Put it in the URI, set QUERYBARA_PASSWORD, or run in a terminal to be asked',
        });
      }
      password = await runtime.ctx.prompter.secret(`Password for ${name}: `);
    }
  }

  const draftAuth = draft.auth;
  const user = draftAuth && 'user' in draftAuth ? draftAuth.user : undefined;
  const mechanism = draftAuth?.method === 'password' ? draftAuth.mechanism : undefined;
  const ref: SecretRef | undefined =
    policy !== undefined
      ? {
          id: (draftAuth?.method === 'password' ? draftAuth.password?.id : undefined) ?? newId(),
          policy,
        }
      : undefined;
  const auth =
    ref !== undefined || draftAuth?.method === 'password'
      ? {
          method: 'password' as const,
          ...(user !== undefined ? { user } : {}),
          ...(mechanism !== undefined ? { mechanism } : {}),
          ...(ref !== undefined ? { password: ref } : {}),
        }
      : draftAuth;
  const folderId = options.folder !== undefined ? ensureFolder(store, options.folder) : null;
  const saved = store.profiles.save({
    ...draft,
    ...(existing ? { id: existing.id } : {}),
    name,
    ...(auth !== undefined ? { auth } : {}),
    ...(options.tls !== undefined ? { tls: { ...draft.tls, mode: options.tls } } : {}),
    presentation: {
      folderId,
      tags: [...options.tags],
      environment: options.environment ?? 'dev',
      readOnly: options.readOnly ?? false,
      confirmWrites: options.confirmWrites ?? false,
    },
  });
  if (ref !== undefined && password !== undefined) store.secrets.set(ref, password);
  await writeLine(
    runtime,
    `${existing ? 'Replaced' : 'Added'} profile "${saved.name}" (${ENGINES[saved.engine].displayName} at ${describeEndpoint(saved)}, id ${saved.id})`,
  );
  if (ref !== undefined) {
    runtime.reporter.info(
      ref.policy === 'save'
        ? 'The password is saved, sealed with QUERYBARA_PASSPHRASE.'
        : `The password is not stored; querybara-cli reads ${passwordEnvName(saved.name)} or QUERYBARA_PASSWORD, or asks.`,
    );
  }
  return EXIT.ok;
}

/** A folder id, or a "/"-separated path whose missing folders are created. */
function ensureFolder(store: Store, spec: string): string {
  if (store.folders.get(spec)) return spec;
  const parts = spec
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) throw new CliError('The folder path is empty');
  let parentId: string | null = null;
  for (const part of parts) {
    const siblings = store.folders.list({ parentId });
    const found =
      siblings.find((f) => f.name === part) ??
      siblings.find((f) => f.name.toLowerCase() === part.toLowerCase());
    parentId = found ? found.id : store.folders.create({ name: part, parentId }).id;
  }
  return parentId!;
}

// ---------------------------------------------------------------------------------------------
// remove

export async function removeProfile(
  runtime: Runtime,
  spec: string,
  options: { yes: boolean },
): Promise<ExitCode> {
  const store = requireExistingStore(runtime, spec);
  const profile = findProfile(store, spec);
  await confirmOperation(`Remove profile "${profile.name}" and its saved secrets and history?`, {
    yes: options.yes,
    prompter: runtime.ctx.prompter,
    reporter: runtime.reporter,
  });
  store.profiles.delete(profile.id);
  await writeLine(runtime, `Removed profile "${profile.name}" (${profile.id})`);
  return EXIT.ok;
}

// ---------------------------------------------------------------------------------------------
// export / import

const EXPORT_PASSPHRASE_ENV = 'QUERYBARA_EXPORT_PASSPHRASE';

async function exportPassphrase(runtime: Runtime, confirm: boolean): Promise<string> {
  const fromEnv = runtime.ctx.env[EXPORT_PASSPHRASE_ENV];
  if (fromEnv) return fromEnv;
  const { prompter } = runtime.ctx;
  if (!prompter.interactive) {
    throw new CliError('The export file passphrase is needed', {
      hint: `Set ${EXPORT_PASSPHRASE_ENV}, or run in a terminal to be asked`,
    });
  }
  const passphrase = await prompter.secret('Export file passphrase: ');
  if (passphrase === '') throw new CliError('The passphrase must not be empty');
  if (confirm && (await prompter.secret('Repeat the passphrase: ')) !== passphrase) {
    throw new CliError('The passphrases do not match');
  }
  return passphrase;
}

export async function exportCommand(
  runtime: Runtime,
  file: string,
  options: { profiles: readonly string[]; includeSecrets: boolean },
): Promise<ExitCode> {
  const store = runtime.store.open({ create: false });
  const profiles: StoredProfile[] =
    options.profiles.length > 0
      ? options.profiles.map((spec) => findProfile(requireExistingStore(runtime, spec), spec))
      : (store?.profiles.list() ?? []);
  if (profiles.length === 0) throw new CliError('There are no profiles to export');
  const passphrase = await exportPassphrase(runtime, true);

  const allFolders = new Map((store?.folders.list() ?? []).map((f) => [f.id, f]));
  const folders = new Map<string, ExportedFolder>();
  for (const profile of profiles) {
    let id = profile.presentation.folderId;
    while (id !== null && !folders.has(id)) {
      const folder = allFolders.get(id);
      if (!folder) break;
      folders.set(id, {
        id,
        parentId: folder.parentId,
        name: folder.name,
        sortOrder: folder.sortOrder,
      });
      id = folder.parentId;
    }
  }
  let secrets: Record<string, string> | undefined;
  if (options.includeSecrets && store) {
    secrets = {};
    let unavailable = 0;
    for (const profile of profiles) {
      const resolved = store.secrets.resolve(profile);
      for (const [id, value] of Object.entries(resolved.secrets)) secrets[id] = value;
      unavailable += resolved.missing.filter((ref) => ref.policy === 'save').length;
    }
    if (unavailable > 0) {
      runtime.reporter.warn(
        `${plural(unavailable, 'saved secret')} could not be read here and ${unavailable === 1 ? 'is' : 'are'} not in the file (sealed by the desktop app's keychain, or QUERYBARA_PASSPHRASE is not set or differs)`,
      );
    }
  }
  const data = exportProfiles(
    profiles.map(({ version: _version, ...profile }) => profile),
    { passphrase, folders: [...folders.values()], ...(secrets ? { secrets } : {}) },
  );
  writeFileSync(resolve(runtime.ctx.cwd, file), data, { mode: 0o600 });
  await writeLine(
    runtime,
    `Exported ${plural(profiles.length, 'profile')}${secrets ? ` with ${plural(Object.keys(secrets).length, 'secret')}` : ''} to ${file}`,
  );
  return EXIT.ok;
}

export async function importCommand(
  runtime: Runtime,
  file: string,
  options: { replace: boolean },
): Promise<ExitCode> {
  let data: Uint8Array;
  try {
    data = readFileSync(resolve(runtime.ctx.cwd, file));
  } catch (error) {
    throw new CliError(`Cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? 'error'}`, {
      code: 'NOT_FOUND',
    });
  }
  const passphrase = await exportPassphrase(runtime, false);
  const imported = importProfiles(data, passphrase);
  const store = runtime.store.require();

  for (const folder of imported.folders) {
    if (store.folders.get(folder.id)) continue;
    const parentId =
      folder.parentId !== null && store.folders.get(folder.parentId) ? folder.parentId : null;
    store.folders.create({
      id: folder.id,
      name: folder.name,
      parentId,
      sortOrder: folder.sortOrder,
    });
  }
  let added = 0;
  let replaced = 0;
  let skipped = 0;
  let savedSecrets = 0;
  let unsavedSecrets = 0;
  const canSave = store.secrets.canSave();
  for (const profile of imported.profiles) {
    const exists = store.profiles.get(profile.id) !== undefined;
    if (exists && !options.replace) {
      skipped++;
      continue;
    }
    store.profiles.save(profile);
    if (exists) replaced++;
    else added++;
    for (const ref of secretRefsOf(profile)) {
      const value = imported.secrets[ref.id];
      if (value === undefined || ref.policy !== 'save') continue;
      if (!canSave) {
        unsavedSecrets++;
        continue;
      }
      store.secrets.set(ref, value);
      savedSecrets++;
    }
  }
  await writeLine(
    runtime,
    `Imported ${plural(added + replaced, 'profile')} from ${file}${replaced > 0 ? ` (${replaced} replaced)` : ''}${savedSecrets > 0 ? `, ${plural(savedSecrets, 'secret')} saved` : ''}`,
  );
  if (skipped > 0) {
    runtime.reporter.warn(
      `${plural(skipped, 'profile')} already existed and ${skipped === 1 ? 'was' : 'were'} skipped; pass --replace to overwrite`,
    );
  }
  if (unsavedSecrets > 0) {
    runtime.reporter.warn(
      `${plural(unsavedSecrets, 'secret')} in the file ${unsavedSecrets === 1 ? 'was' : 'were'} not saved: set QUERYBARA_PASSPHRASE to save secrets`,
    );
  }
  return EXIT.ok;
}
