import { describe, expect, it } from 'vitest';

import {
  backupInspectionSchema,
  backupMainContractShape,
  jobInfoSchema,
  jobSpecSchema,
  mainContract,
  restorePlanSchema,
} from '../src/index';

/**
 * The backup and restore schemas (spec §14): jobs travel in the jobs contract's spec union,
 * passphrases are bounded and never empty, and the wizards' inspection and plan results
 * validate what the job runner answers.
 */

const PROFILE_ID = '8a3f7c1e-2b4d-4e6f-9a1b-3c5d7e9f0a2b';

const backup = {
  kind: 'backup',
  profileId: PROFILE_ID,
  database: 'shop',
  format: 'jbak',
  output: { path: '/backups/shop.jbak' },
  encryption: { passphrase: 'correct horse' },
  selection: {
    schemas: ['public'],
    include: [{ kind: 'table', schema: 'public', name: 'orders' }],
  },
};

const restore = {
  kind: 'restore',
  profileId: PROFILE_ID,
  path: '/backups/shop.jbak',
  passphrase: 'correct horse',
  select: ['table:public.orders:create'],
  onError: 'stop',
  confirmedConflicts: ['table:public.orders:create'],
};

describe('backup schemas', () => {
  it('accepts backup and restore jobs in the job spec union', () => {
    expect(jobSpecSchema.parse(backup)).toEqual(backup);
    expect(jobSpecSchema.parse(restore)).toEqual(restore);
    expect(jobInfoSchema.shape.kind.options).toEqual(expect.arrayContaining(['backup', 'restore']));
  });

  it('refuses what a job cannot run', () => {
    const bad = [
      { ...backup, format: 'zip' },
      { ...backup, output: { path: '' } },
      { ...backup, encryption: { passphrase: '' } },
      { ...backup, method: 'pg_dumpall' },
      { ...backup, selection: { include: [{ kind: 'wizard', name: 'x' }] } },
      { ...restore, onError: undefined },
      { ...restore, passphrase: 'x'.repeat(1025) },
      { ...restore, select: [''] },
    ];
    for (const job of bad)
      expect(jobSpecSchema.safeParse(job).success, JSON.stringify(job)).toBe(false);
  });

  it('validates what the wizards get back', () => {
    expect(
      backupInspectionSchema.safeParse({ format: 'jbak', size: 10, encrypted: true }).success,
    ).toBe(true);
    expect(
      backupInspectionSchema.safeParse({ format: 'tar', size: 10, encrypted: false }).success,
    ).toBe(false);
    expect(
      restorePlanSchema.safeParse({
        format: 'jbak',
        objects: ['a'],
        added: [],
        skipped: [{ id: 'b', reason: 'needs c' }],
        conflicts: [{ id: 'a', kind: 'table', qualifiedName: 'public.a', action: 'truncate' }],
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it('adds the backup namespace to the main contract', () => {
    expect(Object.keys(backupMainContractShape)).toEqual(['inspect', 'planRestore', 'nativeTools']);
    expect(mainContract.shape.backup).toBe(backupMainContractShape);
  });
});
