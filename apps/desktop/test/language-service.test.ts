import { schemaSnapshotSchema, tableDefSchema, type SchemaSnapshot } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { LanguageClient, type WorkerLike } from '../src/renderer/src/lib/language-client';
import {
  LanguageService,
  resolveKeywordCase,
  type LanguageRequest,
  type LanguageResponse,
} from '../src/renderer/src/workers/language-service';

/**
 * The language worker's message protocol (spec §6): snapshots in; completion, signature help,
 * syntax errors and the designer's expression checks out; one response per request, stale
 * requests cancelled. The service runs in-process; messages are structured-cloned as
 * postMessage would.
 */

function pgSnapshot(database: string, tables: Record<string, string[]>, schema = 'public') {
  return schemaSnapshotSchema.parse({
    engine: 'postgres',
    database,
    schemas: [
      {
        name: schema,
        tables: Object.entries(tables).map(([name, columns]) => ({
          name,
          columns: columns.map((column, i) => ({
            name: column,
            ordinal: i + 1,
            dataType: 'integer',
            nullable: true,
          })),
        })),
        routines: [
          {
            name: 'order_total',
            kind: 'function',
            arguments: [{ name: 'order_id', dataType: 'integer', mode: 'in' }],
            returns: 'numeric',
            language: 'sql',
            definition: 'select 1',
          },
        ],
      },
    ],
    capturedAt: '2026-09-29T10:00:00.000Z',
  });
}

function mysqlSnapshot(database: string, tables: string[]): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine: 'mysql',
    database,
    schemas: [
      {
        name: database,
        tables: tables.map((name) => ({
          name,
          columns: [{ name: 'id', ordinal: 1, dataType: 'int', nullable: false }],
        })),
      },
    ],
    capturedAt: '2026-09-29T10:00:00.000Z',
  });
}

/** A service with a hand-cranked scheduler: `tick()` runs one queued task. */
function manualService() {
  const responses: LanguageResponse[] = [];
  const tasks: (() => void)[] = [];
  const service = new LanguageService((response) => responses.push(structuredClone(response)), {
    schedule: (task) => tasks.push(task),
  });
  const send = (message: LanguageRequest): void => service.handle(structuredClone(message));
  const tick = (): void => tasks.shift()?.();
  const drain = (): void => {
    while (tasks.length > 0) tick();
  };
  return { service, responses, send, tick, drain };
}

const PG = { dialect: 'postgres' } as const;

describe('LanguageService', () => {
  it('completes from the snapshots of the connection a request names', () => {
    const { send, drain, responses } = manualService();
    send({ type: 'snapshots', profileId: 'a', put: [pgSnapshot('shop', { orders: ['id'] })] });
    send({ type: 'snapshots', profileId: 'b', put: [pgSnapshot('crm', { invoices: ['id'] })] });
    const text = 'SELECT * FROM ';
    send({ type: 'complete', id: 1, profileId: 'a', context: PG, text, offset: text.length });
    send({ type: 'complete', id: 2, profileId: 'b', context: PG, text, offset: text.length });
    send({ type: 'complete', id: 3, context: PG, text, offset: text.length });
    drain();
    const labels = (id: number): string[] => {
      const response = responses.find((r) => r.id === id);
      if (response?.type !== 'complete') throw new Error(`no completion for ${id}`);
      return response.result.items.filter((i) => i.kind === 'table').map((i) => i.label);
    };
    expect(labels(1)).toEqual(['orders']);
    expect(labels(2)).toEqual(['invoices']);
    // No connection: keywords and functions only.
    expect(labels(3)).toEqual([]);
    const first = responses.find((r) => r.id === 1);
    expect(first).toMatchObject({ type: 'complete', result: { from: 14, to: 14 } });
  });

  it('resolves names in the session context each request carries', () => {
    const { send, drain, responses } = manualService();
    send({
      type: 'snapshots',
      profileId: 'a',
      put: [
        schemaSnapshotSchema.parse({
          ...pgSnapshot('shop', { orders: ['id'] }),
          schemas: [
            ...pgSnapshot('shop', { orders: ['id'] }).schemas,
            ...pgSnapshot('shop', { ledgers: ['id'] }, 'accounting').schemas,
          ],
        }),
      ],
    });
    const text = 'SELECT * FROM ';
    const request = { type: 'complete', profileId: 'a', text, offset: text.length } as const;
    send({ ...request, id: 1, context: PG });
    send({ ...request, id: 2, context: { ...PG, searchPath: ['accounting', 'public'] } });
    drain();
    const tables = (id: number) => {
      const response = responses.find((r) => r.id === id);
      return response?.type === 'complete'
        ? response.result.items.filter((i) => i.kind === 'table').map((i) => i.label)
        : [];
    };
    expect(tables(1)).toEqual(['orders', 'accounting.ledgers']);
    expect(tables(2)).toEqual(expect.arrayContaining(['ledgers', 'orders']));
  });

  it('rebuilds a catalog when the snapshots change, and forgets a connection', () => {
    const { send, drain, responses } = manualService();
    const text = 'SELECT * FROM ';
    const ask = (id: number) =>
      send({ type: 'complete', id, profileId: 'a', context: PG, text, offset: text.length });
    send({ type: 'snapshots', profileId: 'a', put: [pgSnapshot('shop', { orders: ['id'] })] });
    ask(1);
    drain();
    send({
      type: 'snapshots',
      profileId: 'a',
      put: [pgSnapshot('shop', { orders: ['id'], refunds: ['id'] })],
    });
    ask(2);
    drain();
    send({ type: 'forget', profileId: 'a' });
    ask(3);
    drain();
    const tables = responses.map((r) =>
      r.type === 'complete' ? r.result.items.filter((i) => i.kind === 'table').length : -1,
    );
    expect(tables).toEqual([1, 2, 0]);
  });

  it('offers MySQL databases known only by name', () => {
    const { send, drain, responses } = manualService();
    send({
      type: 'snapshots',
      profileId: 'm',
      put: [mysqlSnapshot('shop', ['orders'])],
      databases: ['crm', 'shop'],
    });
    const text = 'SELECT * FROM ';
    send({
      type: 'complete',
      id: 1,
      profileId: 'm',
      context: { dialect: 'mysql', currentDatabase: 'shop' },
      text,
      offset: text.length,
    });
    drain();
    const response = responses[0];
    if (response?.type !== 'complete') throw new Error('no completion');
    const labels = response.result.items.map((i) => `${i.kind}:${i.label}`);
    expect(labels).toEqual(expect.arrayContaining(['table:orders', 'database:crm']));
  });

  it('answers a request cancelled while queued with `cancelled` and never runs it', () => {
    const { send, drain, responses } = manualService();
    send({ type: 'complete', id: 1, context: PG, text: 'SEL', offset: 3 });
    send({ type: 'complete', id: 2, context: PG, text: 'SEL', offset: 3 });
    send({ type: 'cancel', id: 1 });
    drain();
    expect(responses.map((r) => `${r.id}:${r.type}`)).toEqual(['1:cancelled', '2:complete']);
    // Cancelling something that already answered is ignored.
    send({ type: 'cancel', id: 2 });
    drain();
    expect(responses).toHaveLength(2);
  });

  it('lets a newer request replace a queued one on the same channel only', () => {
    const { send, drain, responses } = manualService();
    const at = (id: number, channel: string, text: string) =>
      send({ type: 'complete', id, channel, context: PG, text, offset: text.length });
    at(1, 'tab-1', 'S');
    at(2, 'tab-2', 'S');
    at(3, 'tab-1', 'SE');
    send({ type: 'signature', id: 4, channel: 'tab-1', context: PG, text: 'lpad(', offset: 5 });
    drain();
    expect(responses.map((r) => `${r.id}:${r.type}`)).toEqual([
      '1:cancelled',
      '2:complete',
      '3:complete',
      '4:signature',
    ]);
  });

  it('runs one request per task, so cancels posted meanwhile are seen first', () => {
    const { send, tick, responses } = manualService();
    send({ type: 'complete', id: 1, context: PG, text: 'S', offset: 1 });
    send({ type: 'complete', id: 2, context: PG, text: 'S', offset: 1 });
    tick();
    expect(responses.map((r) => r.id)).toEqual([1]);
    send({ type: 'cancel', id: 2 });
    tick();
    expect(responses.map((r) => `${r.id}:${r.type}`)).toEqual(['1:complete', '2:cancelled']);
  });

  it('gives signature help for built-in functions and the connection routines', () => {
    const { send, drain, responses } = manualService();
    send({ type: 'snapshots', profileId: 'a', put: [pgSnapshot('shop', { orders: ['id'] })] });
    const builtin = 'SELECT lpad(name, ';
    send({ type: 'signature', id: 1, context: PG, text: builtin, offset: builtin.length });
    const routine = 'SELECT order_total(';
    send({
      type: 'signature',
      id: 2,
      profileId: 'a',
      context: PG,
      text: routine,
      offset: routine.length,
    });
    send({ type: 'signature', id: 3, context: PG, text: 'SELECT 1', offset: 8 });
    drain();
    const [lpad, total, none] = responses;
    expect(lpad).toMatchObject({ type: 'signature', result: { name: 'lpad', activeParameter: 1 } });
    expect(total).toMatchObject({ type: 'signature', result: { name: 'order_total' } });
    expect(none).toEqual({ type: 'signature', id: 3, result: null });
  });

  it('reports a failure as an error response', () => {
    const { send, drain, responses } = manualService();
    const broken = { ...pgSnapshot('shop', {}), schemas: null } as unknown as SchemaSnapshot;
    send({ type: 'snapshots', profileId: 'a', put: [broken] });
    send({ type: 'complete', id: 1, profileId: 'a', context: PG, text: 'SELECT ', offset: 7 });
    drain();
    expect(responses[0]).toMatchObject({ type: 'error', id: 1 });
  });

  it('keeps diagnose working, and cancels one in flight', async () => {
    const responses: LanguageResponse[] = [];
    const service = new LanguageService((response) => responses.push(response));
    service.handle({ type: 'diagnose', id: 1, text: 'selec 1', dialect: 'postgres' });
    service.handle({ type: 'diagnose', id: 2, text: 'select 1', dialect: 'postgres' });
    // The first diagnose loads the parser, which a fully parallel workspace run on a small CI
    // machine can slow to well past ten seconds.
    await expect.poll(() => responses.length, { timeout: 50_000 }).toBe(2);
    const [bad, good] = responses;
    expect(bad).toMatchObject({ type: 'diagnose', id: 1 });
    expect(bad?.type === 'diagnose' && bad.diagnostics.length).toBe(1);
    expect(good).toEqual({ type: 'diagnose', id: 2, diagnostics: [] });

    // Started (not queued) when the cancel comes: it finishes, and answers `cancelled`.
    const manual = manualService();
    manual.send({ type: 'diagnose', id: 3, text: 'selec 2', dialect: 'postgres' });
    manual.tick();
    manual.send({ type: 'cancel', id: 3 });
    await expect.poll(() => manual.responses.length, { timeout: 30_000 }).toBe(1);
    expect(manual.responses[0]).toEqual({ type: 'cancelled', id: 3 });
  }, 90_000);
});

describe('LanguageService: table designer checks', () => {
  it('parses a designed table`s expressions and reports the broken ones', async () => {
    const responses: LanguageResponse[] = [];
    const service = new LanguageService((response) => responses.push(response));
    const table = tableDefSchema.parse({
      name: 'orders',
      columns: [{ name: 'id', ordinal: 1, dataType: 'integer', nullable: false }],
      checks: [
        { name: 'broken', expression: 'id >> > 0' },
        { name: 'fine', expression: 'id > 0' },
      ],
    });
    service.handle({ type: 'diagnose-table', id: 7, table, engine: 'postgres', schema: 'public' });
    // Loads the parser too (see above).
    await expect.poll(() => responses.length, { timeout: 50_000 }).toBe(1);
    expect(responses[0]).toEqual({
      type: 'diagnose-table',
      id: 7,
      issues: [
        expect.objectContaining({
          path: 'checks[0].expression',
          code: 'syntax',
          severity: 'error',
        }),
      ],
    });
  }, 90_000);
});

describe('resolveKeywordCase', () => {
  it('uses the setting, upper by default', () => {
    expect(resolveKeywordCase(undefined, 'sel', 3)).toBe('upper');
    expect(resolveKeywordCase('upper', 'sel', 3)).toBe('upper');
    expect(resolveKeywordCase('lower', 'SEL', 3)).toBe('lower');
  });

  it('preserves the case of the word being typed, else of the keywords before it', () => {
    expect(resolveKeywordCase('preserve', 'sel', 3)).toBe('lower');
    expect(resolveKeywordCase('preserve', 'Sel', 3)).toBe('upper');
    expect(resolveKeywordCase('preserve', 'select * from t ', 16)).toBe('lower');
    expect(resolveKeywordCase('preserve', 'SELECT * FROM t ', 16)).toBe('upper');
    expect(resolveKeywordCase('preserve', '', 0)).toBe('upper');
  });
});

/** A WorkerLike running the service in-process, with structured cloning both ways. */
class InProcessWorker implements WorkerLike {
  readonly sent: LanguageRequest[] = [];
  terminated = false;
  readonly #messages: ((event: { data: LanguageResponse }) => void)[] = [];
  readonly #errors: (() => void)[] = [];
  readonly #service = new LanguageService((response) => {
    const data = structuredClone(response);
    queueMicrotask(() => {
      for (const listener of this.#messages) listener({ data });
    });
  });

  postMessage(message: LanguageRequest): void {
    this.sent.push(message);
    this.#service.handle(structuredClone(message));
  }

  addEventListener(type: 'message' | 'error', listener: never): void {
    if (type === 'message') this.#messages.push(listener);
    else this.#errors.push(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  crash(): void {
    for (const listener of this.#errors) listener();
  }
}

describe('LanguageClient', () => {
  function client() {
    const workers: InProcessWorker[] = [];
    const language = new LanguageClient(() => {
      const worker = new InProcessWorker();
      workers.push(worker);
      return worker;
    });
    return { language, workers };
  }

  it('matches replies to requests', async () => {
    const { language } = client();
    language.setSnapshots('a', { put: [pgSnapshot('shop', { orders: ['id'] })] });
    const text = 'SELECT * FROM ord';
    const [result, help] = await Promise.all([
      language.complete({ profileId: 'a', context: PG, text, offset: text.length }),
      language.signatureHelp({ context: PG, text: 'SELECT lpad(', offset: 12 }),
    ]);
    expect(result?.items[0]).toMatchObject({ label: 'orders', kind: 'table' });
    expect(result).toMatchObject({ from: 14, to: 17, incomplete: false });
    expect(help?.name).toBe('lpad');
  });

  it('resolves a cancelled request with nothing and tells the worker', async () => {
    const { language, workers } = client();
    const controller = new AbortController();
    const pending = language.complete({ context: PG, text: 'S', offset: 1 }, controller.signal);
    controller.abort();
    expect(await pending).toBeUndefined();
    expect(workers[0]?.sent.map((m) => m.type)).toEqual(['complete', 'cancel']);
    const aborted = new AbortController();
    aborted.abort();
    expect(await language.complete({ context: PG, text: 'S', offset: 1 }, aborted.signal)).toBe(
      undefined,
    );
  });

  it('replaces a crashed worker and refills it with the snapshots it had', async () => {
    const { language, workers } = client();
    language.setSnapshots('a', { put: [pgSnapshot('shop', { orders: ['id'] })] });
    await language.complete({ context: PG, text: 'S', offset: 1 });
    language.setSnapshots('a', { put: [pgSnapshot('shop', { orders: ['id'], refunds: ['id'] })] });
    workers[0]!.crash();
    expect(workers[0]!.terminated).toBe(true);
    const text = 'SELECT * FROM ';
    const result = await language.complete({
      profileId: 'a',
      context: PG,
      text,
      offset: text.length,
    });
    expect(workers).toHaveLength(2);
    expect(workers[1]!.sent[0]).toMatchObject({ type: 'snapshots', profileId: 'a', replace: true });
    expect(result?.items.filter((i) => i.kind === 'table').map((i) => i.label)).toEqual([
      'orders',
      'refunds',
    ]);
  });

  it('never rejects a diagnose request', async () => {
    const { language, workers } = client();
    const pending = language.diagnose('select 1', 'postgres');
    workers[0]!.crash();
    expect(await pending).toEqual([]);
  });
});
