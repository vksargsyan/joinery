import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  JoineryError,
  type ConnectionProfile,
  type ResolvedProfile,
  type SchemaSnapshot,
} from '@joinery/core';
import {
  dataScriptPreviewSchema,
  structureScriptSchema,
  type DataActions,
  type DataCompareInput,
  type DataResult,
  type DataRowAction,
  type DataRowPage,
  type DataScriptPreview,
  type JobInfo,
  type StructureCompareInput,
  type StructureResult,
  type StructureScript,
  type SyncSide,
} from '@joinery/ipc';
import { z } from 'zod';

import {
  syncJobResultSchema,
  type structureJobResultSchema,
  type DataJobResult,
  type JobSide,
  type SyncJobSpec,
} from '../shared/sync-jobs';
import { rowPageFile, rowPageFileSchema } from '../shared/sync-spool';
import type { JobDescription, JobManager } from './jobs';

/**
 * Structure and data sync in main (spec §13, ADR 0009): starts the sync jobs in the job runner
 * and keeps what they found, so the page can tick operations, ask for scripts, page through row
 * differences and apply, naming the job instead of sending diffs back and forth.
 *
 * A structure comparison keeps its diff and the source structure it read (an apply re-compares
 * against it: step 8). A data comparison keeps the folder its job spooled rows and statements
 * into; main pages the rows out of it and the runner reads the statements back. Comparisons are
 * forgotten when the page discards them, when newer ones push them out, and at quit, together
 * with their folders.
 */

/** A structure result as main parsed it from the runner. */
type ParsedStructure = z.infer<typeof structureJobResultSchema>;

type StructureEntry = Omit<ParsedStructure, 'source' | 'sourceSnapshot'> & {
  readonly jobId: string;
  readonly source: NonNullable<ParsedStructure['source']>;
  readonly sourceSnapshot: SchemaSnapshot;
  /** The target side as the compare named it (database, schemas), for applies. */
  readonly targetSide: JobSide;
};

type DataEntry = DataJobResult & {
  readonly jobId: string;
  readonly targetSide: JobSide;
  readonly options: DataCompareInput['options'];
  readonly spoolDir: string;
};

type Entry = StructureEntry | DataEntry;

export interface SyncServiceOptions {
  readonly jobs: JobManager;
  /** A folder of this app run; each data compare spools into a folder of its own under it. */
  readonly spoolRoot: string;
  /** Finished comparisons kept; the oldest is forgotten first. */
  readonly keep?: number;
}

const DATA_PREVIEW_STATEMENTS = 200;

function sideOf(side: SyncSide): JobSide {
  return {
    ...(side.database !== undefined ? { database: side.database } : {}),
    ...(side.schemas !== undefined && side.schemas.length > 0 ? { schemas: side.schemas } : {}),
  };
}

function sideLabel(profile: ConnectionProfile, side: JobSide): string {
  return side.database !== undefined ? `${profile.name} (${side.database})` : profile.name;
}

function gone(): JoineryError {
  return new JoineryError({
    code: 'NOT_FOUND',
    message: 'That comparison is no longer available',
    hint: 'Compare again.',
  });
}

export class SyncService {
  readonly #jobs: JobManager;
  readonly #root: string;
  readonly #keep: number;
  readonly #entries = new Map<string, Entry>();
  #spoolRoot: string | undefined;

  constructor(options: SyncServiceOptions) {
    this.#jobs = options.jobs;
    this.#root = options.spoolRoot;
    this.#keep = options.keep ?? 20;
  }

  /** Starts a structure compare job between two resolved connections. */
  startStructureCompare(
    input: Pick<StructureCompareInput, 'source' | 'target' | 'options'>,
    resolved: { readonly source: ResolvedProfile; readonly target: ResolvedProfile },
    options: { readonly silent?: boolean } = {},
  ): string {
    const target = sideOf(input.target);
    const spec: SyncJobSpec = {
      kind: 'structure-compare',
      profileId: input.target.profileId,
      sourceProfileId: input.source.profileId,
      source: sideOf(input.source),
      target,
      options: input.options,
    };
    const description: JobDescription = {
      title: `Compare structure: ${sideLabel(resolved.source.profile, spec.source)} → ${sideLabel(resolved.target.profile, target)}`,
      target: target.database !== undefined ? { database: target.database } : {},
    };
    return this.#jobs.start(spec, resolved.target, description, {
      source: resolved.source,
      silent: options.silent === true,
      onDone: (job, result) => {
        const parsed = this.#parse(job, result);
        if (parsed?.kind !== 'structure' || !parsed.source || !parsed.sourceSnapshot) return;
        this.#keepEntry({
          ...parsed,
          jobId: job.id,
          source: parsed.source,
          sourceSnapshot: parsed.sourceSnapshot,
          targetSide: target,
        });
      },
    }).id;
  }

  /** The target connection of a kept structure comparison (the one an apply writes to). */
  structureTarget(jobId: string): string {
    return this.#structure(jobId).target.profileId;
  }

  structureResult(jobId: string): StructureResult {
    const entry = this.#structure(jobId);
    const { order: _order, ...diff } = entry.diff;
    return {
      jobId,
      source: entry.source,
      target: entry.target,
      diff,
      summary: entry.summary,
      script: entry.script,
      ...(entry.applied !== undefined ? { applied: entry.applied } : {}),
    };
  }

  /** The script for a selection, generated in the job runner. */
  async structureScript(jobId: string, selected: readonly string[]): Promise<StructureScript> {
    const { diff } = this.#structure(jobId);
    return structureScriptSchema.parse(
      await this.#jobs.request({
        kind: 'sync-script',
        input: { diff, selected: [...selected] },
      }),
    );
  }

  /** Applies a selection of a kept comparison; the result is the re-compare. */
  startStructureApply(
    input: {
      readonly jobId: string;
      readonly selected: readonly string[];
      readonly scriptSha256: string;
      readonly confirmed: boolean;
    },
    target: ResolvedProfile,
  ): string {
    const entry = this.#structure(input.jobId);
    const spec: SyncJobSpec = {
      kind: 'structure-apply',
      profileId: entry.target.profileId,
      target: entry.targetSide,
      diff: entry.diff,
      selected: [...input.selected],
      sourceSnapshot: entry.sourceSnapshot,
      scriptSha256: input.scriptSha256,
      confirmed: input.confirmed,
    };
    return this.#jobs.start(
      spec,
      target,
      {
        title: `Apply structure changes to ${sideLabel(target.profile, entry.targetSide)}`,
        target:
          entry.targetSide.database !== undefined ? { database: entry.targetSide.database } : {},
      },
      {
        onDone: (job, result) => {
          const parsed = this.#parse(job, result);
          if (parsed?.kind !== 'structure') return;
          this.#keepEntry({
            ...parsed,
            jobId: job.id,
            source: entry.source,
            sourceSnapshot: entry.sourceSnapshot,
            targetSide: entry.targetSide,
          });
        },
      },
    ).id;
  }

  /** Writes a selection's script or HTML report (the path was granted by the caller). */
  async exportStructure(input: {
    readonly jobId: string;
    readonly selected: readonly string[];
    readonly format: 'sql' | 'html';
    readonly path: string;
  }): Promise<{ bytes: number }> {
    const entry = this.#structure(input.jobId);
    const label = (side: StructureEntry['source']): string =>
      `${side.profileName} (${side.database})`;
    return z.object({ bytes: z.number().int().nonnegative() }).parse(
      await this.#jobs.request({
        kind: 'sync-export',
        input: {
          diff: entry.diff,
          selected: [...input.selected],
          format: input.format,
          path: input.path,
          sourceLabel: `Source: ${label(entry.source)}`,
          targetLabel: `Target: ${label(entry.target)}`,
          generatedAt: new Date().toISOString(),
        },
      }),
    );
  }

  /** Starts a data compare job; its rows spool into a new folder. */
  startDataCompare(
    input: Pick<DataCompareInput, 'source' | 'target' | 'options' | 'tables'>,
    resolved: { readonly source: ResolvedProfile; readonly target: ResolvedProfile },
    options: { readonly silent?: boolean } = {},
  ): string {
    const target = sideOf(input.target);
    const spoolDir = mkdtempSync(join(this.#spoolFolder(), 'data-'));
    const spec: SyncJobSpec = {
      kind: 'data-compare',
      profileId: input.target.profileId,
      sourceProfileId: input.source.profileId,
      source: sideOf(input.source),
      target,
      options: input.options,
      ...(input.tables !== undefined ? { tables: input.tables } : {}),
      spoolDir,
    };
    try {
      return this.#jobs.start(
        spec,
        resolved.target,
        {
          title: `Compare data: ${sideLabel(resolved.source.profile, spec.source)} → ${sideLabel(resolved.target.profile, target)}`,
          target: target.database !== undefined ? { database: target.database } : {},
        },
        {
          source: resolved.source,
          silent: options.silent === true,
          onDone: (job, result) => {
            const parsed = this.#parse(job, result);
            if (parsed?.kind !== 'data') {
              removeFolder(spoolDir);
              return;
            }
            this.#keepEntry({
              ...parsed,
              jobId: job.id,
              targetSide: target,
              options: input.options,
              spoolDir,
            });
          },
        },
      ).id;
    } catch (error) {
      removeFolder(spoolDir);
      throw error;
    }
  }

  dataTarget(jobId: string): string {
    return this.#data(jobId).target.profileId;
  }

  dataResult(jobId: string): DataResult {
    const entry = this.#data(jobId);
    return {
      jobId,
      source: entry.source,
      target: entry.target,
      options: entry.options,
      tables: entry.tables,
      skipped: entry.skipped,
      pageSize: entry.pageSize,
    };
  }

  /** One page of a table's row differences for one action, read from the spool. */
  async dataRows(input: {
    readonly jobId: string;
    readonly table: number;
    readonly action: DataRowAction;
    readonly page: number;
  }): Promise<DataRowPage> {
    const entry = this.#data(input.jobId);
    const table = entry.tables.find((t) => t.index === input.table);
    if (!table) throw new JoineryError({ code: 'NOT_FOUND', message: 'No such table' });
    const total = table.stored[input.action];
    const pageCount = Math.ceil(total / entry.pageSize);
    if (input.page >= pageCount) return { rows: [], page: input.page, pageCount, total };
    let text: string;
    try {
      text = await readFile(
        join(entry.spoolDir, rowPageFile(input.table, input.action, input.page)),
        'utf8',
      );
    } catch {
      throw gone();
    }
    return {
      rows: rowPageFileSchema.parse(JSON.parse(text)),
      page: input.page,
      pageCount,
      total,
    };
  }

  /** The start of a selection's data sync script, generated in the job runner. */
  async dataPreview(input: {
    readonly jobId: string;
    readonly tables: readonly number[];
    readonly actions: DataActions;
  }): Promise<DataScriptPreview> {
    const entry = this.#data(input.jobId);
    const answer = await this.#jobs.request({
      kind: 'sync-data-script',
      input: {
        spoolDir: entry.spoolDir,
        tables: [...input.tables],
        actions: input.actions,
        limit: DATA_PREVIEW_STATEMENTS,
      },
    });
    return dataScriptPreviewSchema.parse(answer);
  }

  /** Applies a selection's spooled changes to the target. */
  startDataApply(
    input: {
      readonly jobId: string;
      readonly tables: readonly number[];
      readonly actions: DataActions;
      readonly confirmed: boolean;
    },
    target: ResolvedProfile,
  ): string {
    const entry = this.#data(input.jobId);
    const spec: SyncJobSpec = {
      kind: 'data-apply',
      profileId: entry.target.profileId,
      target: entry.targetSide,
      spoolDir: entry.spoolDir,
      tables: [...input.tables],
      actions: input.actions,
      confirmed: input.confirmed,
    };
    return this.#jobs.start(spec, target, {
      title: `Apply data changes to ${sideLabel(target.profile, entry.targetSide)}`,
      target:
        entry.targetSide.database !== undefined ? { database: entry.targetSide.database } : {},
    }).id;
  }

  /** Writes a selection's data sync script (the path was granted by the caller). */
  async exportData(input: {
    readonly jobId: string;
    readonly tables: readonly number[];
    readonly actions: DataActions;
    readonly path: string;
  }): Promise<{ bytes: number }> {
    const entry = this.#data(input.jobId);
    const answer = z.object({ bytes: z.number().int().nonnegative() }).parse(
      await this.#jobs.request({
        kind: 'sync-data-script',
        input: {
          spoolDir: entry.spoolDir,
          tables: [...input.tables],
          actions: input.actions,
          path: input.path,
        },
      }),
    );
    return { bytes: answer.bytes };
  }

  /** Forgets a comparison (and removes its spool folder). Unknown ids are ignored. */
  discard(jobId: string): void {
    const entry = this.#entries.get(jobId);
    if (!entry) return;
    this.#entries.delete(jobId);
    if (entry.kind === 'data') removeFolder(entry.spoolDir);
  }

  /** Forgets everything and removes every spool folder (app quit). */
  dispose(): void {
    this.#entries.clear();
    if (this.#spoolRoot !== undefined) removeFolder(this.#spoolRoot);
    this.#spoolRoot = undefined;
  }

  #spoolFolder(): string {
    if (this.#spoolRoot === undefined) {
      mkdirSync(this.#root, { recursive: true });
      this.#spoolRoot = mkdtempSync(join(this.#root, 'joinery-sync-'));
    }
    return this.#spoolRoot;
  }

  /** A sync job's result, when it completed with one that parses. */
  #parse(job: JobInfo, result: unknown): z.infer<typeof syncJobResultSchema> | undefined {
    if (job.state !== 'completed' || result === undefined) return undefined;
    const parsed = syncJobResultSchema.safeParse(result);
    return parsed.success ? parsed.data : undefined;
  }

  #keepEntry(entry: Entry): void {
    this.#entries.set(entry.jobId, entry);
    while (this.#entries.size > this.#keep) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.discard(oldest);
    }
  }

  #structure(jobId: string): StructureEntry {
    const entry = this.#entries.get(jobId);
    if (entry?.kind !== 'structure') throw gone();
    return entry;
  }

  #data(jobId: string): DataEntry {
    const entry = this.#entries.get(jobId);
    if (entry?.kind !== 'data') throw gone();
    return entry;
  }
}

function removeFolder(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // A folder that cannot be removed now is left to the OS's temporary file cleanup.
  }
}
