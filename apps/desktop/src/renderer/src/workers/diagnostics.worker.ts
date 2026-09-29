import type { SqlDialect } from '@joinery/core';
import { diagnose, type SqlDiagnostic } from '@joinery/sql-tools';

/**
 * The editor's language worker (spec §6): inline syntax errors from the dialect parser, parsed
 * off the UI thread so typing never waits for it. The grammar loads on the first request.
 */

export interface DiagnosticsRequest {
  readonly id: number;
  readonly text: string;
  readonly dialect: SqlDialect;
}

export interface DiagnosticsResponse {
  readonly id: number;
  readonly diagnostics: readonly SqlDiagnostic[];
}

self.addEventListener('message', (event: MessageEvent<DiagnosticsRequest>) => {
  const { id, text, dialect } = event.data;
  const reply = (diagnostics: readonly SqlDiagnostic[]): void => {
    const response: DiagnosticsResponse = { id, diagnostics };
    self.postMessage(response);
  };
  diagnose(text, dialect).then(reply, () => reply([]));
});
