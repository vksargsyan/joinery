import type { MongoSavedPipeline, RpcStream } from '@querybara/ipc';
import {
  formatShell,
  stageInfo,
  type DocumentPage,
  type ExplainVerbosity,
  type Namespace,
} from '@querybara/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { confirm } from '../dialogs';
import type { CodeExportRequest } from './code-export';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import type { ExplainState, Notice } from './collection-view';
import { namespaceReference } from './explorer';
import type { TextIssue } from './query-bar';
import { DocumentResults, type ResultMode } from './results';
import {
  checkStages,
  disabledIndexes,
  insertStage,
  moveStage,
  newStage,
  parsePipelineText,
  pipelineDocuments,
  pipelineEjson,
  pipelineText,
  pipelineWritesOutput,
  removeStage,
  setStageBody,
  setStageOperator,
  toggleStage,
  type PipelineStage,
  type StageCheck,
} from './stage-list';
import { DEFAULT_WRITE_RULES, loadWriteRules, type WriteRules } from './write-rules';

/**
 * The aggregation editor (spec §9, "Query tools"): one card per stage, previews of each stage's
 * output on a sample of the collection, the whole pipeline run into the same tree, table and
 * JSON views as the collection view, explain, the pipeline as one editable text, and named
 * pipelines saved per collection. A pipeline ending in $out or $merge writes, so it runs only
 * after a confirmation that shows it (the connection host enforces the write rules too); a
 * read-only profile runs only pipelines that do not write.
 */

export interface AggregationTarget {
  readonly profileId: string;
  readonly db: string;
  readonly collection: string;
  /** Stages to start with (for example a pipeline opened from elsewhere). */
  readonly text?: string;
}

/** What a card shows under its body: the stage's output on the sample. */
export interface StagePreviewState {
  readonly status: 'idle' | 'loading' | 'done' | 'error' | 'skipped';
  /** Canonical Extended JSON of the documents the stage returned (at most PREVIEW_LIMIT). */
  readonly documents: readonly string[];
  readonly durationMs?: number;
  readonly message?: string;
}

export type AggregationTab = ResultMode | 'explain';

export interface AggregationState {
  readonly stages: readonly PipelineStage[];
  readonly checks: Readonly<Record<string, StageCheck>>;
  /** Cards, or the pipeline as one text. */
  readonly mode: 'stages' | 'text';
  readonly text: string;
  readonly textIssue: TextIssue | undefined;
  /** Input documents each preview takes. */
  readonly sampleSize: number;
  /** `limit`: the first N documents; `sample`: $sample (random, slower). */
  readonly sampling: 'limit' | 'sample';
  readonly autoPreview: boolean;
  readonly previews: Readonly<Record<string, StagePreviewState>>;
  readonly running: boolean;
  readonly ran: boolean;
  readonly durationMs: number | undefined;
  readonly tab: AggregationTab;
  readonly explain: ExplainState | undefined;
  readonly notice: Notice | undefined;
  readonly saved: readonly MongoSavedPipeline[];
  /** The saved pipeline the editor holds, if it was loaded or saved. */
  readonly current: { readonly id: string; readonly name: string } | undefined;
  readonly rules: WriteRules;
}

export const DEFAULT_SAMPLE_SIZE = 1000;
/** Documents a preview shows. */
export const PREVIEW_LIMIT = 20;
/** Documents per page of the full run. */
export const RUN_PAGE_SIZE = 100;
/** Pause after an edit before the previews run again. */
export const PREVIEW_DELAY_MS = 450;

export class AggregationEditor {
  readonly id: string;
  readonly target: AggregationTarget;
  readonly store: StoreApi<AggregationState>;
  readonly results = new DocumentResults({ mode: 'tree' });
  readonly #lane: SessionLane;
  #stream: RpcStream<DocumentPage> | undefined;
  #runId = 0;
  #previewGeneration = 0;
  #previewTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(id: string, target: AggregationTarget) {
    this.id = id;
    this.target = target;
    const parsed = target.text !== undefined ? parsePipelineText(target.text) : undefined;
    const stages = parsed?.ok === true ? parsed.stages : [newStage('$match', '{}')];
    this.store = createStore<AggregationState>()(() => ({
      stages,
      checks: checkStages(stages),
      mode: 'stages',
      text: pipelineText(stages),
      textIssue: undefined,
      sampleSize: DEFAULT_SAMPLE_SIZE,
      sampling: 'limit',
      autoPreview: true,
      previews: {},
      running: false,
      ran: false,
      durationMs: undefined,
      tab: 'tree',
      explain: undefined,
      notice: undefined,
      saved: [],
      current: undefined,
      rules: DEFAULT_WRITE_RULES,
    }));
    this.#lane = new SessionLane(target.profileId, target.db);
  }

  get state(): AggregationState {
    return this.store.getState();
  }

  get ns(): Namespace {
    return { db: this.target.db, collection: this.target.collection };
  }

  #set(patch: Partial<AggregationState>): void {
    this.store.setState(patch);
  }

  /** Reads the write rules and the saved pipelines, then previews the stages. */
  async init(): Promise<void> {
    this.#set({ rules: await loadWriteRules(this.target.profileId) });
    await this.refreshSaved();
    if (this.state.autoPreview) await this.previewAll();
  }

  // -------------------------------------------------------------------------------------------
  // Editing

  /** Replaces the stages (from a card edit): checks, text and previews follow. */
  #setStages(stages: PipelineStage[], options: { readonly keepText?: boolean } = {}): void {
    const previews: Record<string, StagePreviewState> = {};
    for (const stage of stages) {
      const previous = this.state.previews[stage.id];
      if (previous) previews[stage.id] = previous;
    }
    this.#set({
      stages,
      checks: checkStages(stages),
      previews,
      ...(options.keepText ? {} : { text: pipelineText(stages), textIssue: undefined }),
    });
    this.#schedulePreview();
  }

  addStage(afterIndex: number, operator = '$match'): string {
    const stage = newStage(operator);
    this.#setStages(insertStage(this.state.stages, afterIndex, stage));
    return stage.id;
  }

  removeStage(id: string): void {
    this.#setStages(removeStage(this.state.stages, id));
  }

  moveStage(from: number, to: number): void {
    this.#setStages(moveStage(this.state.stages, from, to));
  }

  toggleStage(id: string): void {
    this.#setStages(toggleStage(this.state.stages, id));
  }

  setOperator(id: string, operator: string): void {
    this.#setStages(setStageOperator(this.state.stages, id, operator));
  }

  setBody(id: string, body: string): void {
    this.#setStages(setStageBody(this.state.stages, id, body));
  }

  /** The pipeline text typed by hand: when it parses, the cards follow it. */
  setText(text: string): void {
    const parsed = parsePipelineText(text, this.state.stages);
    if (!parsed.ok) {
      this.#set({ text, textIssue: parsed.issue });
      return;
    }
    this.#set({ text, textIssue: undefined });
    this.#setStages(parsed.stages, { keepText: true });
  }

  setMode(mode: 'stages' | 'text'): void {
    if (mode === 'text') this.#set({ mode, text: pipelineText(this.state.stages) });
    else this.#set({ mode });
  }

  setSampleSize(size: number): void {
    if (!Number.isInteger(size) || size < 1 || size > 100_000) return;
    this.#set({ sampleSize: size });
    this.#schedulePreview();
  }

  setSampling(sampling: 'limit' | 'sample'): void {
    this.#set({ sampling });
    this.#schedulePreview();
  }

  setAutoPreview(autoPreview: boolean): void {
    this.#set({ autoPreview });
    if (autoPreview) this.#schedulePreview();
  }

  setTab(tab: AggregationTab): void {
    if (tab !== 'explain') this.results.setMode(tab);
    this.#set({ tab });
  }

  dismissNotice(): void {
    this.#set({ notice: undefined });
  }

  // -------------------------------------------------------------------------------------------
  // Previews

  #schedulePreview(): void {
    this.#previewGeneration += 1;
    if (this.#previewTimer !== undefined) clearTimeout(this.#previewTimer);
    this.#previewTimer = undefined;
    if (!this.state.autoPreview || this.#disposed) return;
    this.#previewTimer = setTimeout(() => {
      this.#previewTimer = undefined;
      void this.previewAll();
    }, PREVIEW_DELAY_MS);
  }

  #setPreview(id: string, preview: StagePreviewState): void {
    this.#set({ previews: { ...this.state.previews, [id]: preview } });
  }

  /** Previews every stage in order (each one's output is the next one's input). */
  async previewAll(): Promise<void> {
    const generation = this.#previewGeneration;
    for (let i = 0; i < this.state.stages.length; i++) {
      if (generation !== this.#previewGeneration || this.#disposed) return;
      await this.#preview(i, generation);
    }
  }

  /** Previews one stage: the enabled stages up to it, on the sample. */
  async previewStage(index: number): Promise<void> {
    await this.#preview(index, this.#previewGeneration);
  }

  async #preview(index: number, generation: number): Promise<void> {
    const stages = this.state.stages.slice(0, index + 1);
    const stage = stages[index];
    if (!stage) return;
    if (!stage.enabled) {
      this.#setPreview(stage.id, {
        status: 'skipped',
        documents: [],
        message: 'Disabled: the next stage gets the documents before this one.',
      });
      return;
    }
    const info = stageInfo(stage.operator);
    if (info?.previewable === false) {
      this.#setPreview(stage.id, {
        status: 'skipped',
        documents: [],
        message: `A ${stage.operator} stage cannot be previewed.`,
      });
      return;
    }
    const broken = stages.findIndex((s) => this.state.checks[s.id]?.issue !== undefined);
    if (broken >= 0) {
      this.#setPreview(stage.id, {
        status: 'error',
        documents: [],
        message:
          broken === index
            ? 'Fix this stage to preview it.'
            : `Fix stage ${broken + 1} to preview this one.`,
      });
      return;
    }
    const previous = this.state.previews[stage.id];
    this.#setPreview(stage.id, { status: 'loading', documents: previous?.documents ?? [] });
    try {
      const pipeline = pipelineEjson(stages, { includeDisabled: true });
      const preview = await this.#lane.run((host, sessionId) =>
        host.mongo.previewStage({
          sessionId,
          ns: this.ns,
          pipeline,
          stageIndex: index,
          sampleSize: this.state.sampleSize,
          sampling: this.state.sampling,
          disabled: disabledIndexes(stages),
          limit: PREVIEW_LIMIT,
        }),
      );
      if (generation !== this.#previewGeneration) return;
      this.#setPreview(stage.id, {
        status: 'done',
        documents: preview.documents,
        durationMs: Math.round(preview.durationMs),
        ...(info?.writes
          ? {
              message: `Preview of the documents ${stage.operator} would write (nothing is written).`,
            }
          : {}),
      });
    } catch (error) {
      if (generation !== this.#previewGeneration) return;
      this.#setPreview(stage.id, { status: 'error', documents: [], message: errorMessage(error) });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Running and explaining

  /** The enabled stages as Extended JSON; shows the problem and returns undefined if invalid. */
  #pipeline(): string | undefined {
    if (this.state.mode === 'text' && this.state.textIssue) {
      this.#set({ notice: { kind: 'error', text: 'Fix the pipeline text first.' } });
      return undefined;
    }
    try {
      return pipelineEjson(this.state.stages);
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return undefined;
    }
  }

  /**
   * The enabled stages as code export takes them; undefined, with a notice, while the pipeline
   * does not parse.
   */
  exportRequest(): CodeExportRequest | undefined {
    if (this.state.mode === 'text' && this.state.textIssue) {
      this.#set({ notice: { kind: 'error', text: 'Fix the pipeline text first.' } });
      return undefined;
    }
    try {
      return {
        target: {
          kind: 'aggregate',
          collection: this.target.collection,
          pipeline: pipelineDocuments(this.state.stages),
        },
        database: this.target.db,
      };
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return undefined;
    }
  }

  /** The mongosh command of the whole run, for the confirmation. */
  commandText(): string {
    const documents = pipelineDocuments(this.state.stages);
    return `${namespaceReference(this.target.db, this.target.collection)}.aggregate(${formatShell(documents)})`;
  }

  /** Runs the enabled stages into the result views; $out / $merge confirm first. */
  async run(): Promise<void> {
    const pipeline = this.#pipeline();
    if (pipeline === undefined) return;
    const writes = pipelineWritesOutput(this.state.stages);
    let confirmed = false;
    if (writes) {
      if (this.state.rules.readOnlyProfile) {
        this.#set({
          notice: {
            kind: 'error',
            text: 'This connection is read-only: a pipeline ending in $out or $merge cannot run.',
          },
        });
        return;
      }
      const last = [...this.state.stages].reverse().find((stage) => stage.enabled)!;
      confirmed = await confirm({
        title: `Run the pipeline and write its results (${last.operator})?`,
        message: `${last.operator} writes the results to a collection${last.operator === '$out' ? ', replacing what it holds' : ''}${this.state.rules.production ? ' on this production connection' : ''}. This runs:`,
        detail: this.commandText(),
        confirmLabel: 'Run and write',
        danger: true,
      });
      if (!confirmed) return;
    }
    const runId = ++this.#runId;
    await this.#closeStream();
    this.results.begin(() => this.#fetch(runId));
    this.#set({
      running: true,
      ran: true,
      notice: undefined,
      tab: this.state.tab === 'explain' ? this.results.state.mode : this.state.tab,
    });
    patchPanel(this.id, { busy: true });
    const started = performance.now();
    try {
      this.#stream = await this.#lane.run(async (host, sessionId) =>
        host.mongo.aggregate({
          sessionId,
          ns: this.ns,
          pipeline,
          pageSize: RUN_PAGE_SIZE,
          ...(writes ? { confirmed } : {}),
        }),
      );
      await this.#fetch(runId);
      if (runId === this.#runId) this.#set({ durationMs: Math.round(performance.now() - started) });
      if (writes && runId === this.#runId && !this.results.state.error) {
        this.#set({ notice: { kind: 'success', text: 'The pipeline ran and wrote its results.' } });
      }
    } finally {
      if (runId === this.#runId) {
        this.#set({ running: false });
        patchPanel(this.id, { busy: false });
      }
    }
  }

  async #fetch(runId: number): Promise<void> {
    const stream = this.#stream;
    if (!stream || runId !== this.#runId) return;
    this.results.setLoading(true);
    try {
      const next = await stream.next();
      if (runId !== this.#runId) return;
      if (next.done) {
        this.results.append([], false);
        this.#stream = undefined;
        return;
      }
      this.results.append(next.value.documents, next.value.documents.length >= RUN_PAGE_SIZE);
    } catch (error) {
      if (runId !== this.#runId) return;
      this.#stream = undefined;
      this.results.fail(errorMessage(error));
    }
  }

  async #closeStream(): Promise<void> {
    const stream = this.#stream;
    this.#stream = undefined;
    await stream?.return().catch(() => undefined);
  }

  /** Explains the enabled stages (queryPlanner, or executionStats which runs them). */
  async explain(verbosity: ExplainVerbosity = 'executionStats'): Promise<void> {
    const pipeline = this.#pipeline();
    if (pipeline === undefined) return;
    this.#set({
      tab: 'explain',
      explain: { verbosity, loading: true, result: undefined, error: undefined },
    });
    try {
      const result = await this.#lane.run((host, sessionId) =>
        host.mongo.explain({
          sessionId,
          ns: this.ns,
          target: { kind: 'aggregate', pipeline },
          verbosity,
        }),
      );
      this.#set({ explain: { verbosity, loading: false, result, error: undefined } });
    } catch (error) {
      this.#set({
        explain: { verbosity, loading: false, result: undefined, error: errorMessage(error) },
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Saved pipelines

  #scope() {
    return {
      profileId: this.target.profileId,
      db: this.target.db,
      collection: this.target.collection,
    };
  }

  async refreshSaved(): Promise<void> {
    try {
      this.#set({ saved: await mainApi().mongo.pipelines.list(this.#scope()) });
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: `Saved pipelines: ${errorMessage(error)}` } });
    }
  }

  /** Saves the pipeline under `name` (a new entry), or over the loaded one without a name. */
  async save(name?: string): Promise<boolean> {
    const current = this.state.current;
    const entryName = name ?? current?.name;
    if (entryName === undefined || entryName.trim() === '') return false;
    const existing =
      name === undefined ? current : this.state.saved.find((p) => p.name === name.trim());
    try {
      const saved = await mainApi().mongo.pipelines.save({
        ...this.#scope(),
        ...(existing ? { id: existing.id } : {}),
        name: entryName.trim(),
        text: pipelineText(this.state.stages),
      });
      this.#set({
        current: { id: saved.id, name: saved.name },
        notice: { kind: 'success', text: `Saved as "${saved.name}"` },
      });
      await this.refreshSaved();
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    }
  }

  /** Loads a saved pipeline into the editor. */
  load(id: string): void {
    const entry = this.state.saved.find((p) => p.id === id);
    if (!entry) return;
    const parsed = parsePipelineText(entry.text);
    if (!parsed.ok) {
      this.#set({
        mode: 'text',
        text: entry.text,
        textIssue: parsed.issue,
        current: { id: entry.id, name: entry.name },
      });
      return;
    }
    this.#set({ current: { id: entry.id, name: entry.name }, notice: undefined });
    this.#setStages(parsed.stages);
  }

  async deleteSaved(id: string): Promise<void> {
    const entry = this.state.saved.find((p) => p.id === id);
    if (!entry) return;
    const ok = await confirm({
      title: `Delete the saved pipeline "${entry.name}"?`,
      message: 'The pipeline in the editor stays; only the saved copy goes.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await mainApi().mongo.pipelines.delete({ id });
      if (this.state.current?.id === id) this.#set({ current: undefined });
      await this.refreshSaved();
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#runId++;
    this.#previewGeneration++;
    if (this.#previewTimer !== undefined) clearTimeout(this.#previewTimer);
    await this.#closeStream();
    await this.#lane.close();
  }
}

/** Subscribes a component to part of an aggregation editor's state. */
export function useAggregation<T>(
  editor: AggregationEditor,
  selector: (state: AggregationState) => T,
): T {
  return useStore(editor.store, selector);
}
