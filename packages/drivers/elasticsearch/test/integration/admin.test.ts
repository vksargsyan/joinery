import { existsSync, rmSync } from 'node:fs';

import {
  aliasSwapActions,
  parseJsonTree,
  stringAt,
  type SearchTable,
  type SearchTaskStatus,
} from '@joinery/search-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SearchSession } from '../../src';
import { SERVERS, allIds, cleanUp, connect, testPrefix } from './helpers';

/**
 * The documents-and-queries and administration services against real servers (spec §11):
 * paging past 10,000 hits with a point in time (and the scroll fallback), SQL with its cursor
 * and Translate to DSL, ES|QL, clone and shrink, reindex as a server task, an atomic alias
 * swap, shard allocation with an explanation and the disk watermarks, templates, lifecycle
 * policies and pipelines with simulation, and snapshots in an `fs` repository. Features follow
 * the cluster's capability flags, so a missing plugin skips its part.
 */

async function waitForTask(session: SearchSession, taskId: string): Promise<SearchTaskStatus> {
  for (let i = 0; i < 600; i++) {
    const task = await session.getTask(taskId);
    if (task.completed) return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`task ${taskId} did not complete`);
}

async function tables(pages: AsyncIterable<SearchTable>): Promise<SearchTable[]> {
  const out: SearchTable[] = [];
  for await (const page of pages) out.push(page);
  return out;
}

/** The first path.repo directory of the cluster, when it has one (snapshots need it). */
async function pathRepo(session: SearchSession): Promise<string | undefined> {
  const response = await session.request({
    method: 'GET',
    path: '/_nodes/settings',
    query: 'filter_path=nodes.*.settings.path.repo',
  });
  const match = /"repo"\s*:\s*\[\s*"([^"]+)"/.exec(response.body);
  return match?.[1];
}

describe.skipIf(SERVERS.length === 0).each(SERVERS)('$engine administration', (server) => {
  const prefix = testPrefix();
  const deep = `${prefix}deep`;
  const people = `${prefix}people`;
  const v1 = `${prefix}orders-v1`;
  const v2 = `${prefix}orders-v2`;
  const alias = `${prefix}orders`;
  const clone = `${prefix}orders-clone`;
  const small = `${prefix}orders-small`;
  const restored = `${prefix}restored-orders-v1`;
  const template = `${prefix}template`;
  const component = `${prefix}component`;
  const pipeline = `${prefix}pipeline`;
  const policy = `${prefix}policy`;
  const repository = `${prefix}repo`;
  let session: SearchSession;
  let repoDir: string | undefined;
  // An index name in SQL: double quotes on Elasticsearch, backquotes on OpenSearch, whose SQL
  // plugin reads a double-quoted name as a string.
  const sqlName = (index: string): string =>
    server.engine === 'opensearch' ? `\`${index}\`` : `"${index}"`;

  beforeAll(async () => {
    session = await connect(server);
  });

  afterAll(async () => {
    if (!session) return;
    await session.deleteResource('index-template', template).catch(() => undefined);
    await session.deleteResource('component-template', component).catch(() => undefined);
    await session.deleteResource('ingest-pipeline', pipeline).catch(() => undefined);
    await session.deleteResource('lifecycle-policy', policy).catch(() => undefined);
    await session.deleteSnapshot(repository, 'snap-1').catch(() => undefined);
    await session.deleteResource('snapshot-repository', repository).catch(() => undefined);
    await cleanUp(session, { indices: [deep, people, v1, v2, clone, small, restored] });
    await session.close();
    if (repoDir && existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true });
  });

  it('pages past 10,000 hits with a point in time, and with the scroll fallback', async () => {
    await session.createIndex(
      deep,
      '{"settings": {"number_of_shards": 2, "number_of_replicas": 0}}',
    );
    const total = 10_250;
    for (let start = 0; start < total; start += 5_000) {
      const lines: string[] = [];
      for (let i = start; i < Math.min(total, start + 5_000); i++) {
        lines.push(`{"index": {"_id": "${i}"}}`, `{"n": ${i}}`);
      }
      const result = await session.bulk(lines.join('\n'), { index: deep });
      expect(result.errors).toBe(false);
    }
    await session.refresh([deep]);
    const pages = [];
    for await (const page of session.search(deep, '{"sort": [{"n": "asc"}]}', {
      pageSize: 2_500,
    })) {
      pages.push(page);
    }
    expect(pages[0]!.paging).toBe('pit');
    expect(pages[0]!.total).toEqual({ value: 10_000, relation: 'gte' });
    const ids = pages.flatMap((p) => p.hits.map((h) => h.id));
    expect(ids).toHaveLength(total);
    expect(ids[10_100]).toBe('10100');
    expect(new Set(ids).size).toBe(total);
    const scrolled = await allIds(
      session.search(deep, undefined, { pageSize: 5_000, paging: 'scroll' }),
    );
    expect(new Set(scrolled).size).toBe(total);
  });

  it('runs SQL with a cursor, translates it to DSL, and runs ES|QL', async (context) => {
    if (session.searchCapabilities.sql === null) {
      context.skip();
      return;
    }
    await session.createIndex(
      people,
      '{"mappings": {"properties": {"name": {"type": "keyword"}, "team": {"type": "keyword"}, "score": {"type": "long"}}}}',
    );
    await session.bulk(
      [
        ['ada', 'core', '12345678901234567'],
        ['bo', 'core', '2'],
        ['cy', 'web', '3'],
        ['di', 'web', '4'],
        ['ed', 'ops', '5'],
      ]
        .map(
          ([name, team, score]) =>
            `{"index": {}}\n{"name": "${name}", "team": "${team}", "score": ${score}}`,
        )
        .join('\n'),
      { index: people, refresh: true },
    );
    const paged = await tables(
      session.sql(`SELECT name, score FROM ${sqlName(people)} ORDER BY name`, { fetchSize: 2 }),
    );
    expect(paged.map((p) => p.rows.length)).toEqual([2, 2, 1]);
    expect(paged[0]!.columns.map((c) => c.name)).toEqual(['name', 'score']);
    expect(paged[0]!.rows[0]).toEqual(['"ada"', '12345678901234567']);
    expect(paged.slice(0, 2).every((p) => p.more)).toBe(true);
    expect(paged[2]!.more).toBeUndefined();
    // Stopping early closes the cursor; maxRows cuts the last page.
    const capped = await tables(
      session.sql(`SELECT name FROM ${sqlName(people)}`, { fetchSize: 2, maxRows: 3 }),
    );
    expect(capped.flatMap((p) => p.rows)).toHaveLength(3);

    const grouped = await tables(
      session.sql(`SELECT team, COUNT(*) AS n FROM ${sqlName(people)} GROUP BY team ORDER BY team`),
    );
    expect(grouped[0]!.rows).toEqual([
      ['"core"', '2'],
      ['"ops"', '1'],
      ['"web"', '2'],
    ]);
    const translation = await session.translateSql(
      `SELECT team, COUNT(*) FROM ${sqlName(people)} WHERE score > 2 GROUP BY team`,
    );
    expect(translation.target).toBe(people);
    expect(translation.dsl).toBeDefined();
    const dsl = parseJsonTree(translation.dsl!);
    expect(dsl.type).toBe('object');
    expect(translation.dsl).toContain('aggregations');

    if (session.searchCapabilities.esql) {
      const esql = await session.esql(`FROM ${people} | STATS n = COUNT(*) BY team | SORT team`);
      expect(esql.columns.map((c) => c.name)).toEqual(['n', 'team']);
      expect(esql.rows[0]).toEqual(['2', '"core"']);
    } else {
      await expect(session.esql('FROM x')).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
    }
  });

  it('refuses SQL where the cluster has none', async (context) => {
    if (session.searchCapabilities.sql !== null) {
      context.skip();
      return;
    }
    await expect(tables(session.sql('SELECT 1'))).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('reindexes as a server task and swaps an alias atomically', async () => {
    await session.createIndex(
      v1,
      `{"settings": {"number_of_shards": 2, "number_of_replicas": 0}, "mappings": {"properties": {"total": {"type": "long"}}}, "aliases": {${JSON.stringify(alias)}: {}}}`,
    );
    await session.bulk(
      Array.from({ length: 50 }, (_, i) => `{"index": {"_id": "${i}"}}\n{"total": ${i}}`).join(
        '\n',
      ),
      { index: v1, refresh: true },
    );
    await session.createIndex(
      v2,
      '{"settings": {"number_of_replicas": 0}, "mappings": {"properties": {"total": {"type": "double"}}}}',
    );
    const { taskId } = await session.startReindex({ source: [v1], dest: v2 });
    expect(taskId).toMatch(/^[^:]+:\d+$/);
    const task = await waitForTask(session, taskId);
    expect(task).toMatchObject({ completed: true, failures: 0 });
    expect(task.progress).toMatchObject({ total: 50, created: 50 });
    await session.refresh([v2]);
    expect(await session.count(v2)).toBe(50);

    await session.updateAliases(aliasSwapActions(alias, [v1], v2));
    const aliases = await session.listAliases();
    expect(aliases.filter((a) => a.alias === alias).map((a) => a.index)).toEqual([v2]);

    await expect(session.getTask('nosuchnode:1')).rejects.toBeDefined();
    await expect(session.cancelTask('not a task')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(Array.isArray(await session.listTasks({ actions: '*search*' }))).toBe(true);
  });

  it('clones and shrinks an index, blocking and unblocking the source', async () => {
    await session.resizeIndex('clone', v1, clone, { blockSource: true, unblockSource: true });
    expect(await session.count(clone)).toBe(50);
    await session.resizeIndex('shrink', v1, small, {
      settings: '{"index.number_of_shards": 1, "index.number_of_replicas": 0}',
      blockSource: true,
      unblockSource: true,
    });
    const listed = await session.listIndices({ pattern: `${prefix}orders-*` });
    expect(listed.find((i) => i.name === small)?.primaries).toBe(1);
    // Neither the source nor the new indices keep the write block.
    for (const name of [v1, clone, small]) {
      const settings = parseJsonTree(await session.getSettings(name));
      expect(stringAt(settings, name, 'settings', 'index', 'blocks', 'write')).toBeUndefined();
    }
    await session.indexDocument(v1, '{"total": 99}', { id: 'after', refresh: true });
  });

  it('lists shards, explains an unassigned replica and reads the disk watermarks', async () => {
    await session.putSettings(v1, '{"index": {"number_of_replicas": 1}}');
    const list = await session.shards({ index: v1 });
    expect(list.some((s) => s.primary && s.state === 'STARTED')).toBe(true);
    const nodes = await session.nodes();
    if (nodes.length === 1) {
      const unassigned = list.find((s) => !s.primary && s.state === 'UNASSIGNED');
      expect(unassigned?.unassignedReason).toBeDefined();
      const explain = await session.allocationExplain({ index: v1, shard: 0, primary: false });
      expect(explain).toMatchObject({ index: v1, primary: false, currentState: 'unassigned' });
      expect(explain.decisions[0]?.reasons.join(' ')).toMatch(/same_shard|already allocated/);
    }
    const primary = await session.allocationExplain({ index: v1, shard: 0, primary: true });
    expect(primary.currentState).toBe('started');
    await session.putSettings(v1, '{"index": {"number_of_replicas": 0}}');
    const disk = await session.diskAllocation();
    expect(disk.low).not.toBe('');
    expect(disk.nodes.length).toBeGreaterThan(0);
    expect(disk.nodes[0]!.diskTotalBytes).toBeGreaterThan(0);
  });

  it('keeps templates, lifecycle policies and pipelines, and simulates a pipeline', async () => {
    await session.putResource(
      'component-template',
      component,
      '{"template": {"settings": {"number_of_replicas": 0}}}',
    );
    await session.putResource(
      'index-template',
      template,
      `{"index_patterns": ["${prefix}tpl-*"], "priority": 321, "composed_of": ["${component}"]}`,
    );
    const templates = await session.listResources('index-template');
    const found = templates.find((t) => t.name === template);
    expect(found?.summary).toContainEqual({ label: 'Priority', value: '321' });
    // The body read back is accepted by PUT as it is.
    await session.putResource('index-template', template, found!.body);
    expect((await session.listResources('component-template')).map((t) => t.name)).toContain(
      component,
    );

    await session.putResource(
      'ingest-pipeline',
      pipeline,
      '{"description": "Tidy", "processors": [{"lowercase": {"field": "name"}}, {"set": {"field": "seen", "value": true}}]}',
    );
    const pipelines = await session.listResources('ingest-pipeline');
    expect(pipelines.find((p) => p.name === pipeline)?.summary).toContainEqual({
      label: 'Processors',
      value: 'lowercase, set',
    });
    const simulated = await session.simulatePipeline(
      undefined,
      '[{"name": "ADA", "n": 1234567890123456789}, {"other": 1}]',
      { id: pipeline, verbose: true },
    );
    expect(simulated[0]!.source).toContain('"ada"');
    expect(simulated[0]!.source).toContain('1234567890123456789');
    expect(simulated[0]!.processors.map((p) => p.status)).toEqual(['success', 'success']);
    expect(simulated[1]!.error).toMatch(/name/);
    const inline = await session.simulatePipeline(
      '{"processors": [{"uppercase": {"field": "a"}}]}',
      '{"a": "x"}',
    );
    expect(inline[0]!.source).toContain('"X"');

    if (session.searchCapabilities.lifecycle === 'ilm') {
      await session.putResource(
        'lifecycle-policy',
        policy,
        '{"policy": {"phases": {"hot": {"actions": {}}, "delete": {"min_age": "30d", "actions": {"delete": {}}}}}}',
      );
      const policies = await session.listResources('lifecycle-policy');
      expect(policies.find((p) => p.name === policy)?.summary[0]).toEqual({
        label: 'Phases',
        value: 'hot, delete',
      });
    } else if (session.searchCapabilities.lifecycle === null) {
      await expect(session.listResources('lifecycle-policy')).rejects.toMatchObject({
        code: 'NOT_SUPPORTED',
      });
    }
    await session.deleteResource('index-template', template);
    expect((await session.listResources('index-template')).map((t) => t.name)).not.toContain(
      template,
    );
  });

  it('snapshots an index into an fs repository and restores it under a new name', async (context) => {
    const base = await pathRepo(session);
    if (base === undefined) {
      // path.repo is not set on this server: fs repositories are refused.
      context.skip();
      return;
    }
    repoDir = `${base}/${prefix}repo`;
    await session.putResource(
      'snapshot-repository',
      repository,
      JSON.stringify({ type: 'fs', settings: { location: repoDir } }),
    );
    expect((await session.verifyRepository(repository)).length).toBeGreaterThan(0);
    const repos = await session.listResources('snapshot-repository');
    expect(repos.find((r) => r.name === repository)?.summary).toContainEqual({
      label: 'Type',
      value: 'fs',
    });
    await session.createSnapshot(repository, 'snap-1', { indices: [v1], waitForCompletion: true });
    const snapshots = await session.listSnapshots(repository);
    expect(snapshots[0]).toMatchObject({ snapshot: 'snap-1', state: 'SUCCESS', indices: [v1] });
    await session.restoreSnapshot(repository, 'snap-1', {
      indices: [v1],
      renamePattern: `${prefix}(.+)`,
      renameReplacement: `${prefix}restored-$1`,
      waitForCompletion: true,
    });
    await session.refresh([restored]);
    expect(await session.count(restored)).toBe(51);
    await session.deleteSnapshot(repository, 'snap-1');
    expect(await session.listSnapshots(repository)).toEqual([]);
  });
});
