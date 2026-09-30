import { JoineryError } from '@joinery/core';

import type { CodeExportOptions, CodeLanguage, ExportTarget } from './common';
import { csharpProgram } from './csharp';
import { goProgram } from './go';
import { javaProgram } from './java';
import { nodeProgram } from './node';
import { phpProgram } from './php';
import { pythonProgram } from './python';

/** What the export dialog shows for each language. */
export interface CodeExportLanguage {
  readonly id: CodeLanguage;
  readonly label: string;
  /** The official driver the snippet uses. */
  readonly driver: string;
  /** How to install it. */
  readonly install: string;
  /** A file name the snippet can be saved and run as. */
  readonly fileName: string;
  /** The editor language id for syntax highlighting (Monaco's ids). */
  readonly editorLanguage: string;
}

export const CODE_EXPORT_LANGUAGES: readonly CodeExportLanguage[] = [
  {
    id: 'node',
    label: 'Node.js',
    driver: 'mongodb',
    install: 'npm install mongodb',
    fileName: 'query.js',
    editorLanguage: 'javascript',
  },
  {
    id: 'python',
    label: 'Python',
    driver: 'PyMongo',
    install: 'pip install pymongo',
    fileName: 'query.py',
    editorLanguage: 'python',
  },
  {
    id: 'java',
    label: 'Java',
    driver: 'MongoDB Java Driver (sync)',
    install: 'Maven: org.mongodb:mongodb-driver-sync',
    fileName: 'Query.java',
    editorLanguage: 'java',
  },
  {
    id: 'csharp',
    label: 'C#',
    driver: 'MongoDB.Driver',
    install: 'dotnet add package MongoDB.Driver',
    fileName: 'Program.cs',
    editorLanguage: 'csharp',
  },
  {
    id: 'go',
    label: 'Go',
    driver: 'mongo-go-driver v2',
    install: 'go get go.mongodb.org/mongo-driver/v2/mongo',
    fileName: 'main.go',
    editorLanguage: 'go',
  },
  {
    id: 'php',
    label: 'PHP',
    driver: 'mongodb/mongodb',
    install: 'composer require mongodb/mongodb',
    fileName: 'query.php',
    editorLanguage: 'php',
  },
];

const PROGRAMS: Readonly<Record<CodeLanguage, (target: ExportTarget, database: string) => string>> =
  {
    node: nodeProgram,
    python: pythonProgram,
    java: javaProgram,
    csharp: csharpProgram,
    go: goProgram,
    php: phpProgram,
  };

/**
 * Code export (spec §9, query tools): a complete program in `language` that connects with the
 * official driver, runs the find() or aggregate() and prints each result document. The
 * connection string is read from the MONGODB_URI environment variable, so a snippet never
 * holds credentials.
 *
 * Every BSON type is written in the language's native form, keeping its exact type: Int32,
 * Int64 and Double stay distinct (`1.0` where the language would read `1` as an integer),
 * Decimal128, dates (UTC), ObjectIds, binary with its subtype, UUIDs (standard subtype 4),
 * regular expressions with their flags, Timestamps, MinKey and MaxKey. Documents keep their key
 * order (Go uses `bson.D`). Two approximations: PyMongo and the PHP extension cannot write the
 * deprecated Symbol type, so symbols become strings there; lone UTF-16 surrogates become U+FFFD,
 * as every driver's UTF-8 encoding makes them.
 */
export function exportQueryCode(
  target: ExportTarget,
  language: CodeLanguage,
  options: CodeExportOptions,
): string {
  if (options.database === '') {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'Choose a database to export for',
    });
  }
  if (target.collection === '') {
    throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'The query has no collection' });
  }
  return PROGRAMS[language](target, options.database);
}
