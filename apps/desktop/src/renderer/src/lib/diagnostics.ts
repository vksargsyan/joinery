import type { SqlDialect } from '@joinery/core';
import type { SqlDiagnostic } from '@joinery/sql-tools';

import type { DiagnosticsResponse } from '../workers/diagnostics.worker';
import DiagnosticsWorker from '../workers/diagnostics.worker?worker';

/** One shared diagnostics worker for every editor; requests are matched to replies by id. */

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, (diagnostics: readonly SqlDiagnostic[]) => void>();

function start(): Worker {
  if (worker) return worker;
  const started = new DiagnosticsWorker();
  started.addEventListener('message', (event: MessageEvent<DiagnosticsResponse>) => {
    const resolve = pending.get(event.data.id);
    pending.delete(event.data.id);
    resolve?.(event.data.diagnostics);
  });
  started.addEventListener('error', () => {
    // A broken worker only costs the inline errors; the next request starts a new one.
    for (const resolve of pending.values()) resolve([]);
    pending.clear();
    worker = undefined;
  });
  worker = started;
  return started;
}

/** Syntax errors in `text`, at most one per statement. Never rejects. */
export function syntaxDiagnostics(
  text: string,
  dialect: SqlDialect,
): Promise<readonly SqlDiagnostic[]> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    start().postMessage({ id, text, dialect });
  });
}
