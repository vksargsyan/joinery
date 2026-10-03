import {
  QuerybaraError,
  connectionProfileSchema,
  secretRefsOf,
  type ConnectionProfile,
} from '@querybara/core';
import { z } from 'zod';

import { parseOrThrow } from '../internal/errors';
import { secretRecord } from '../internal/redact';
import {
  DEFAULT_SCRYPT_COST,
  PassphraseKeys,
  decryptEnvelope,
  encryptEnvelope,
  type ScryptCost,
} from '../secrets/envelope';

/**
 * The passphrase-encrypted profile export (spec §4, "Export to a passphrase-encrypted file").
 * The file is the shared envelope format (AES-256-GCM, scrypt, random salt and nonce) around a
 * versioned JSON document holding the profiles, their folders and, when asked, their secrets.
 */

const EXPORT_MAGIC = 'QBRX';
const PAYLOAD_FORMAT = 'querybara.profiles';
const PAYLOAD_VERSION = 1;

export const exportedFolderSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  name: z.string().trim().min(1),
  sortOrder: z.number().int(),
});
export type ExportedFolder = z.infer<typeof exportedFolderSchema>;

const payloadSchema = z.object({
  format: z.literal(PAYLOAD_FORMAT),
  version: z.literal(PAYLOAD_VERSION),
  exportedAt: z.iso.datetime({ offset: true }),
  profiles: z.array(connectionProfileSchema),
  folders: z.array(exportedFolderSchema).default([]),
  secrets: z.record(z.string(), z.string()).default({}),
});

export interface ExportProfilesOptions {
  readonly passphrase: string;
  /**
   * Secret values by SecretRef.id to include. Only secrets the exported profiles reference are
   * written; without this option the file holds no secrets.
   */
  readonly secrets?: Readonly<Record<string, string>>;
  /**
   * Folders to recreate the tree on import (typically every ancestor of the profiles). The file
   * lists them parents first; a folder or profile pointing at a folder that is not exported
   * lands at the root, so the file always imports cleanly.
   */
  readonly folders?: readonly ExportedFolder[];
  /** scrypt cost; lower it only in tests. */
  readonly cost?: ScryptCost;
  readonly now?: () => Date;
}

export interface ImportedProfiles {
  readonly exportedAt: string;
  /** Profiles keep their ids: saving one whose id exists replaces that profile. */
  readonly profiles: ConnectionProfile[];
  /** Parents first, so creating them in order never refers to a missing parent. */
  readonly folders: ExportedFolder[];
  /** Secret values by SecretRef.id; JSON and inspect show `[redacted]`. */
  readonly secrets: Readonly<Record<string, string>>;
}

/** Encrypts profiles (and optionally folders and secrets) into an export file. */
export function exportProfiles(
  profiles: readonly ConnectionProfile[],
  options: ExportProfilesOptions,
): Uint8Array {
  const keys = new PassphraseKeys(options.passphrase);
  const folders = parentsFirst(
    (options.folders ?? []).map((folder) =>
      parseOrThrow(
        exportedFolderSchema,
        {
          id: folder.id,
          parentId: folder.parentId,
          name: folder.name,
          sortOrder: folder.sortOrder,
        },
        'folder',
      ),
    ),
  );
  const folderIds = new Set(folders.map((folder) => folder.id));
  const validProfiles = profiles.map((profile) => {
    const valid = parseOrThrow(connectionProfileSchema, profile, 'connection profile');
    const folderId = valid.presentation.folderId;
    return folderId === null || folderIds.has(folderId)
      ? valid
      : { ...valid, presentation: { ...valid.presentation, folderId: null } };
  });
  const secrets: Record<string, string> = {};
  const given = options.secrets;
  if (given) {
    for (const ref of validProfiles.flatMap(secretRefsOf)) {
      const value = Object.hasOwn(given, ref.id) ? given[ref.id] : undefined;
      if (value !== undefined) secrets[ref.id] = value;
    }
  }
  const payload = {
    format: PAYLOAD_FORMAT,
    version: PAYLOAD_VERSION,
    exportedAt: (options.now?.() ?? new Date()).toISOString(),
    profiles: validProfiles,
    folders,
    secrets,
  };
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  return encryptEnvelope(EXPORT_MAGIC, plaintext, keys, options.cost ?? DEFAULT_SCRYPT_COST);
}

/**
 * Decrypts and validates an export file. A wrong passphrase or a modified file fails with
 * AUTH_FAILED; a file from a newer Querybara with NOT_SUPPORTED.
 */
export function importProfiles(data: Uint8Array, passphrase: string): ImportedProfiles {
  const plaintext = decryptEnvelope(
    EXPORT_MAGIC,
    data,
    new PassphraseKeys(passphrase),
    'export file',
  );
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    throw new QuerybaraError({ code: 'VALIDATION_FAILED', message: 'The export file is damaged' });
  }
  if (
    typeof document === 'object' &&
    document !== null &&
    'version' in document &&
    typeof document.version === 'number' &&
    document.version > PAYLOAD_VERSION
  ) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: `The export file was written by a newer Querybara (format ${document.version})`,
      hint: 'Update Querybara to import it.',
    });
  }
  const payload = parseOrThrow(payloadSchema, document, 'export file');
  return {
    exportedAt: payload.exportedAt,
    profiles: payload.profiles,
    folders: payload.folders,
    secrets: secretRecord(Object.entries(payload.secrets)),
  };
}

/** Orders folders parents first and detaches any whose parent is missing or forms a cycle. */
function parentsFirst(folders: readonly ExportedFolder[]): ExportedFolder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const ordered: ExportedFolder[] = [];
  const placed = new Set<string>();
  const place = (folder: ExportedFolder, descendants: ReadonlySet<string>): void => {
    if (placed.has(folder.id)) return;
    const chain = new Set(descendants).add(folder.id);
    const parent = folder.parentId === null ? undefined : byId.get(folder.parentId);
    const attached = parent !== undefined && !chain.has(parent.id);
    if (attached) place(parent, chain);
    placed.add(folder.id);
    ordered.push(attached ? folder : { ...folder, parentId: null });
  };
  for (const folder of folders) place(folder, new Set());
  return ordered;
}
