import {
  CODE_EXPORT_LANGUAGES,
  exportQueryCode,
  type CodeExportLanguage,
  type CodeLanguage,
  type ExportTarget,
} from '@querybara/mongo-tools';

import { errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';

/**
 * Code export (spec §9, "Query tools"): the query of a collection view, an aggregation editor or
 * a SQL tab as a complete program for the official driver of Node.js, Python, Java, C#, Go or
 * PHP (`exportQueryCode`, in the renderer). The program reads the connection string from
 * MONGODB_URI, so it never holds credentials. The language picked last is picked again.
 */

/** What an export dialog is asked to show. */
export interface CodeExportRequest {
  readonly target: ExportTarget;
  /** The database the collection is in. */
  readonly database: string;
}

let lastLanguage: CodeLanguage = 'node';

export function lastExportLanguage(): CodeLanguage {
  return lastLanguage;
}

export function rememberExportLanguage(language: CodeLanguage): void {
  lastLanguage = language;
}

export function exportLanguage(id: CodeLanguage): CodeExportLanguage {
  return CODE_EXPORT_LANGUAGES.find((language) => language.id === id) ?? CODE_EXPORT_LANGUAGES[0]!;
}

/** The program for a request in one language, or why there is none. */
export function exportedCode(
  request: CodeExportRequest,
  language: CodeLanguage,
): { readonly code: string } | { readonly error: string } {
  try {
    return { code: exportQueryCode(request.target, language, { database: request.database }) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

/** "orders · find()": what the dialog says it exports. */
export function exportSubject(request: CodeExportRequest): string {
  const { target } = request;
  return `${request.database}.${target.collection} · ${target.kind === 'find' ? 'find()' : `aggregate() with ${target.pipeline.length} ${target.pipeline.length === 1 ? 'stage' : 'stages'}`}`;
}

/**
 * Saves a program where the user picks, through main's save dialog and file grants; returns
 * the path, or null when the dialog was cancelled.
 */
export async function saveExportedCode(
  code: string,
  language: CodeExportLanguage,
): Promise<string | null> {
  const extension = language.fileName.slice(language.fileName.lastIndexOf('.') + 1);
  const { path } = await mainApi().dialogs.saveFile({
    title: `Save ${language.label} code`,
    defaultName: language.fileName,
    filters: [{ name: language.label, extensions: [extension] }],
  });
  if (path === null) return null;
  await mainApi().mongo.writeText({ path, text: code });
  return path;
}
