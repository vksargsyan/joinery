import { GRIDFS_READ_LIMIT } from '@querybara/ipc';
import {
  BSONRegExp,
  formatShellInline,
  fromEjson,
  quoteShellString,
  toEjson,
  type GridFsBucketRef,
  type GridFsFileInfo,
} from '@querybara/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorInfo, errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { connect } from '../connections';
import { loadChildren } from '../explorer';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import type { Notice } from './collection-view';
import { namespaceReference } from './explorer';
import {
  DEFAULT_WRITE_RULES,
  READ_ONLY_TEXT,
  confirmMongoWrite,
  loadWriteRules,
  type WriteRules,
} from './write-rules';

/**
 * The GridFS browser (spec §9): a bucket's files a page at a time (newest first), filtered by
 * name; upload and download move whole files by path through main (open and save dialogs, file
 * grants, progress), so the bytes never pass through the page; small text and image files
 * preview from the start of their bytes; rename and delete show what they run on the bucket's
 * `files` and `chunks` collections, and delete always asks.
 */

export const GRIDFS_PAGE_SIZE = 50;
/** Bytes read to preview a text file. */
export const TEXT_PREVIEW_BYTES = 256 * 1024;

/** The filter of a name search: a case-insensitive substring match on `filename`. */
export function nameFilter(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const pattern = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return toEjson({ filename: new BSONRegExp(pattern, 'i') });
}

/** The listing call for one page: one file more than shown, to know whether a next page exists. */
export function pageQuery(
  page: number,
  search: string,
  pageSize = GRIDFS_PAGE_SIZE,
): { filter?: string; sort: string; skip: number; limit: number } {
  const filter = nameFilter(search);
  return {
    ...(filter !== undefined ? { filter } : {}),
    sort: toEjson({ uploadDate: -1, _id: -1 }),
    skip: page * pageSize,
    limit: pageSize + 1,
  };
}

/** A fetched page: the files shown and whether there are more. */
export function pageOf(
  files: readonly GridFsFileInfo[],
  pageSize = GRIDFS_PAGE_SIZE,
): { files: GridFsFileInfo[]; hasNext: boolean } {
  return { files: files.slice(0, pageSize), hasNext: files.length > pageSize };
}

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'csv',
  'tsv',
  'json',
  'xml',
  'html',
  'css',
  'js',
  'ts',
  'yaml',
  'yml',
  'log',
  'sql',
  'ini',
  'conf',
  'toml',
]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

export type PreviewKind =
  | { readonly kind: 'image'; readonly mime: string }
  | { readonly kind: 'text' }
  | { readonly kind: 'none' };

/** How a file previews, from its content type or its name. */
export function previewKindOf(file: Pick<GridFsFileInfo, 'filename' | 'contentType'>): PreviewKind {
  const type = file.contentType?.toLowerCase() ?? '';
  const ext = extensionOf(file.filename);
  if (type.startsWith('image/')) return { kind: 'image', mime: type };
  if (IMAGE_TYPES[ext]) return { kind: 'image', mime: IMAGE_TYPES[ext] };
  if (
    type.startsWith('text/') ||
    type === 'application/json' ||
    type === 'application/xml' ||
    TEXT_EXTENSIONS.has(ext)
  ) {
    return { kind: 'text' };
  }
  return { kind: 'none' };
}

/** The bytes as UTF-8 text, or undefined when they look binary. */
export function decodeText(bytes: Uint8Array, truncated: boolean): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: !truncated }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Extended JSON (a file's _id, its metadata) as mongosh prints it. */
export function shellText(ejson: string): string {
  try {
    return formatShellInline(fromEjson(ejson, 'value'));
  } catch {
    return ejson;
  }
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ...IMAGE_TYPES,
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
};

/** The content type an upload is stored with, from its name; undefined when unknown. */
export function contentTypeFor(filename: string): string | undefined {
  return CONTENT_TYPES[extensionOf(filename)];
}

/** What deleting a file runs: its entry in `<bucket>.files` and its chunks. */
export function deleteFileCommand(bucket: GridFsBucketRef, id: string): string {
  const idText = shellText(id);
  return [
    `${namespaceReference(bucket.db, `${bucket.bucket}.files`)}.deleteOne({ _id: ${idText} })`,
    `${namespaceReference(bucket.db, `${bucket.bucket}.chunks`)}.deleteMany({ files_id: ${idText} })`,
  ].join('\n');
}

/** What renaming a file runs. */
export function renameFileCommand(bucket: GridFsBucketRef, id: string, filename: string): string {
  return `${namespaceReference(bucket.db, `${bucket.bucket}.files`)}.updateOne({ _id: ${shellText(id)} }, { $set: { filename: ${quoteShellString(filename)} } })`;
}

// ---------------------------------------------------------------------------------------------
// The browser

export interface GridFsTarget {
  readonly profileId: string;
  readonly db: string;
  readonly bucket: string;
}

export interface FilePreview {
  readonly id: string;
  readonly status: 'loading' | 'text' | 'image' | 'none' | 'error';
  readonly text?: string;
  readonly bytes?: Uint8Array;
  readonly mime?: string;
  readonly truncated?: boolean;
  readonly message?: string;
}

export interface Transfer {
  readonly kind: 'upload' | 'download';
  readonly name: string;
  readonly bytes: number;
  readonly total: number | undefined;
}

export interface GridFsState {
  readonly search: string;
  readonly page: number;
  readonly files: readonly GridFsFileInfo[];
  readonly hasNext: boolean;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly selected: string | undefined;
  readonly preview: FilePreview | undefined;
  readonly transfer: Transfer | undefined;
  readonly notice: Notice | undefined;
  readonly rules: WriteRules;
}

export class GridFsBrowser {
  readonly id: string;
  readonly target: GridFsTarget;
  readonly store: StoreApi<GridFsState>;
  readonly #lane: SessionLane;
  #loadId = 0;
  #transfer: AbortController | undefined;

  constructor(id: string, target: GridFsTarget) {
    this.id = id;
    this.target = target;
    this.store = createStore<GridFsState>()(() => ({
      search: '',
      page: 0,
      files: [],
      hasNext: false,
      loading: false,
      error: undefined,
      selected: undefined,
      preview: undefined,
      transfer: undefined,
      notice: undefined,
      rules: DEFAULT_WRITE_RULES,
    }));
    this.#lane = new SessionLane(target.profileId, target.db);
  }

  get state(): GridFsState {
    return this.store.getState();
  }

  get bucket(): GridFsBucketRef {
    return { db: this.target.db, bucket: this.target.bucket };
  }

  #set(patch: Partial<GridFsState>): void {
    this.store.setState(patch);
  }

  async init(): Promise<void> {
    this.#set({ rules: await loadWriteRules(this.target.profileId) });
    await this.load();
  }

  /** Reads the current page of files. */
  async load(): Promise<void> {
    const loadId = ++this.#loadId;
    const { page, search } = this.state;
    this.#set({ loading: true, error: undefined });
    try {
      const query = pageQuery(page, search);
      const files = await this.#lane.run(async (host, sessionId) => {
        const all: GridFsFileInfo[] = [];
        for await (const chunk of host.mongo.gridfs.list({
          sessionId,
          bucket: this.bucket,
          ...query,
          pageSize: query.limit,
        })) {
          all.push(...chunk.files);
        }
        return all;
      });
      if (loadId !== this.#loadId) return;
      const shown = pageOf(files);
      this.#set({ ...shown, loading: false });
      if (shown.files.length === 0 && page > 0) {
        this.#set({ page: page - 1 });
        await this.load();
      }
    } catch (error) {
      if (loadId === this.#loadId) this.#set({ loading: false, error: errorMessage(error) });
    }
  }

  setSearch(search: string): void {
    this.#set({ search, page: 0 });
  }

  async goToPage(page: number): Promise<void> {
    if (page < 0 || (page > this.state.page && !this.state.hasNext)) return;
    this.#set({ page });
    await this.load();
  }

  dismissNotice(): void {
    this.#set({ notice: undefined });
  }

  #file(id: string): GridFsFileInfo | undefined {
    return this.state.files.find((file) => file.id === id);
  }

  #refuse(): boolean {
    if (!this.state.rules.readOnlyProfile) return false;
    this.#set({ notice: { kind: 'error', text: READ_ONLY_TEXT } });
    return true;
  }

  // -------------------------------------------------------------------------------------------
  // Preview

  /** Selects a file and previews it when it is text or an image. */
  async select(id: string): Promise<void> {
    const file = this.#file(id);
    if (!file) return;
    this.#set({ selected: id });
    const kind = previewKindOf(file);
    if (kind.kind === 'none') {
      this.#set({ preview: { id, status: 'none', message: 'No preview for this type of file.' } });
      return;
    }
    if (kind.kind === 'image' && file.length > GRIDFS_READ_LIMIT) {
      this.#set({
        preview: { id, status: 'none', message: 'The image is too large to preview; download it.' },
      });
      return;
    }
    this.#set({ preview: { id, status: 'loading' } });
    try {
      const { bytes, truncated } = await this.#lane.run((host, sessionId) =>
        host.mongo.gridfs.read({
          sessionId,
          bucket: this.bucket,
          id,
          maxBytes: kind.kind === 'image' ? GRIDFS_READ_LIMIT : TEXT_PREVIEW_BYTES,
        }),
      );
      if (this.state.selected !== id) return;
      if (kind.kind === 'image') {
        this.#set({ preview: { id, status: 'image', bytes, mime: kind.mime } });
        return;
      }
      const text = decodeText(bytes, truncated);
      this.#set({
        preview:
          text === undefined
            ? { id, status: 'none', message: 'The file is binary; download it to open it.' }
            : { id, status: 'text', text, truncated },
      });
    } catch (error) {
      if (this.state.selected === id) {
        this.#set({ preview: { id, status: 'error', message: errorMessage(error) } });
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Transfers through main

  async #connectionId(): Promise<string> {
    const connection = await connect(this.target.profileId);
    if (connection.connectionId === undefined) throw new Error('Not connected');
    return connection.connectionId;
  }

  /** Picks a file and uploads it into the bucket, with progress. */
  async upload(): Promise<boolean> {
    if (this.#refuse() || this.state.transfer) return false;
    try {
      const { path } = await mainApi().dialogs.openFile({
        title: `Upload to ${this.target.bucket}`,
      });
      if (path === null) return false;
      const name = path.split(/[\\/]/).pop() ?? path;
      const ok = await confirmMongoWrite(this.state.rules, {
        title: `Upload ${name}?`,
        command: `Upload ${name} into the ${this.target.bucket} bucket of ${this.target.db} (${this.target.bucket}.files and ${this.target.bucket}.chunks)`,
        confirmLabel: 'Upload',
      });
      if (!ok) return false;
      const connectionId = await this.#connectionId();
      const controller = new AbortController();
      this.#transfer = controller;
      this.#set({ transfer: { kind: 'upload', name, bytes: 0, total: undefined } });
      const contentType = contentTypeFor(name);
      await mainApi().mongo.gridfs.upload(
        {
          connectionId,
          bucket: this.bucket,
          path,
          ...(contentType !== undefined ? { contentType } : {}),
          confirmed: true,
        },
        {
          signal: controller.signal,
          onProgress: (progress) =>
            this.#set({
              transfer: { kind: 'upload', name, bytes: progress.bytes, total: progress.total },
            }),
        },
      );
      this.#set({ notice: { kind: 'success', text: `Uploaded ${name}` }, page: 0 });
      await this.load();
      await loadChildren(this.target.profileId, [this.target.db, 'gridfs']).catch(() => undefined);
      return true;
    } catch (error) {
      const cancelled = errorInfo(error).code === 'CANCELLED';
      this.#set({
        notice: cancelled
          ? { kind: 'info', text: 'Upload cancelled' }
          : { kind: 'error', text: errorMessage(error) },
      });
      return false;
    } finally {
      this.#transfer = undefined;
      this.#set({ transfer: undefined });
    }
  }

  /** Downloads a file to where the user picks, with progress. */
  async download(id: string): Promise<boolean> {
    const file = this.#file(id);
    if (!file || this.state.transfer) return false;
    try {
      const name = file.filename.split(/[\\/]/).pop() || 'download';
      const { path } = await mainApi().dialogs.saveFile({
        title: 'Download file',
        defaultName: name,
      });
      if (path === null) return false;
      const connectionId = await this.#connectionId();
      const controller = new AbortController();
      this.#transfer = controller;
      this.#set({ transfer: { kind: 'download', name, bytes: 0, total: file.length } });
      const { bytes } = await mainApi().mongo.gridfs.download(
        { connectionId, bucket: this.bucket, id, path },
        {
          signal: controller.signal,
          onProgress: (progress) =>
            this.#set({
              transfer: {
                kind: 'download',
                name,
                bytes: progress.bytes,
                total: progress.total ?? file.length,
              },
            }),
        },
      );
      this.#set({ notice: { kind: 'success', text: `Downloaded ${bytes} bytes to ${path}` } });
      return true;
    } catch (error) {
      const cancelled = errorInfo(error).code === 'CANCELLED';
      this.#set({
        notice: cancelled
          ? { kind: 'info', text: 'Download cancelled' }
          : { kind: 'error', text: errorMessage(error) },
      });
      return false;
    } finally {
      this.#transfer = undefined;
      this.#set({ transfer: undefined });
    }
  }

  cancelTransfer(): void {
    this.#transfer?.abort();
  }

  // -------------------------------------------------------------------------------------------
  // Rename, delete

  async rename(id: string, filename: string): Promise<boolean> {
    const file = this.#file(id);
    const name = filename.trim();
    if (!file || name === '' || name === file.filename || this.#refuse()) return false;
    const ok = await confirmMongoWrite(this.state.rules, {
      title: `Rename ${file.filename} to ${name}?`,
      command: renameFileCommand(this.bucket, id, name),
      confirmLabel: 'Rename',
    });
    if (!ok) return false;
    try {
      await this.#lane.run((host, sessionId) =>
        host.mongo.gridfs.rename({
          sessionId,
          bucket: this.bucket,
          id,
          filename: name,
          confirmed: true,
        }),
      );
      this.#set({ notice: { kind: 'success', text: `Renamed to ${name}` } });
      await this.load();
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    }
  }

  async delete(id: string): Promise<boolean> {
    const file = this.#file(id);
    if (!file || this.#refuse()) return false;
    const ok = await confirmMongoWrite(this.state.rules, {
      title: `Delete ${file.filename}?`,
      command: deleteFileCommand(this.bucket, id),
      destructive: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return false;
    try {
      await this.#lane.run((host, sessionId) =>
        host.mongo.gridfs.delete({ sessionId, bucket: this.bucket, id, confirmed: true }),
      );
      this.#set({
        notice: { kind: 'success', text: `Deleted ${file.filename}` },
        ...(this.state.selected === id ? { selected: undefined, preview: undefined } : {}),
      });
      await this.load();
      await loadChildren(this.target.profileId, [this.target.db, 'gridfs']).catch(() => undefined);
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    }
  }

  async dispose(): Promise<void> {
    this.#loadId++;
    this.#transfer?.abort();
    patchPanel(this.id, { busy: false });
    await this.#lane.close();
  }
}

export function useGridFs<T>(browser: GridFsBrowser, selector: (state: GridFsState) => T): T {
  return useStore(browser.store, selector);
}
