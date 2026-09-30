import { describe, expect, it } from 'vitest';

import {
  parseAllocationExplain,
  parseDiskAllocation,
  parseResources,
  parseShards,
  parseSimulation,
  parseSnapshots,
  parseTaskList,
  parseTaskReply,
  resourcePath,
  resourcePutRequest,
  restoreBody,
  restoredNames,
  simulateBody,
  snapshotBody,
  watermarkPercent,
} from '../src';

describe('tasks', () => {
  it('reads a running reindex with its progress', () => {
    const task = parseTaskReply(
      JSON.stringify({
        completed: false,
        task: {
          node: 'n1',
          id: 42,
          type: 'transport',
          action: 'indices:data/write/reindex',
          status: {
            total: 1000,
            updated: 0,
            created: 250,
            deleted: 0,
            batches: 1,
            version_conflicts: 0,
            noops: 0,
          },
          description: 'reindex from [a] to [b]',
          start_time_in_millis: 1788220800000,
          running_time_in_nanos: 1_500_000_000,
          cancellable: true,
          cancelled: false,
        },
      }),
    );
    expect(task).toEqual({
      id: 'n1:42',
      action: 'indices:data/write/reindex',
      description: 'reindex from [a] to [b]',
      completed: false,
      cancellable: true,
      cancelled: false,
      startedAt: '2026-09-01T00:00:00.000Z',
      runningTimeMs: 1500,
      progress: {
        total: 1000,
        created: 250,
        updated: 0,
        deleted: 0,
        noops: 0,
        versionConflicts: 0,
        batches: 1,
      },
      failures: 0,
    });
  });

  it('reads a finished task from its response, with failures and errors', () => {
    const done = parseTaskReply(
      JSON.stringify({
        completed: true,
        task: {
          node: 'n1',
          id: 7,
          action: 'indices:data/write/reindex',
          status: { total: 3 },
          cancellable: true,
        },
        response: {
          total: 3,
          created: 2,
          updated: 0,
          deleted: 0,
          batches: 1,
          version_conflicts: 1,
          noops: 0,
          failures: [
            {
              index: 'b',
              cause: { type: 'mapper_parsing_exception', reason: 'failed to parse field [n]' },
            },
          ],
        },
      }),
    );
    expect(done).toMatchObject({
      completed: true,
      progress: { total: 3, created: 2, versionConflicts: 1 },
      failures: 1,
      error: 'failed to parse field [n]',
    });
    const failed = parseTaskReply(
      '{"completed": true, "task": {"node": "n", "id": 1, "action": "x"}, "error": {"type": "e", "reason": "outer", "caused_by": {"reason": "inner"}}}',
    );
    expect(failed.error).toBe('inner');
  });

  it('lists tasks in either grouping', () => {
    const flat = parseTaskList(
      '{"tasks": [{"node": "n", "id": 1, "action": "a", "running_time_in_nanos": 5000000}, {"node": "n", "id": 2, "action": "b", "running_time_in_nanos": 9000000}]}',
    );
    expect(flat.map((t) => t.id)).toEqual(['n:2', 'n:1']);
    const byNode = parseTaskList(
      '{"nodes": {"n": {"tasks": {"n:3": {"node": "n", "id": 3, "action": "c"}}}}}',
    );
    expect(byNode.map((t) => t.id)).toEqual(['n:3']);
  });
});

describe('cluster replies', () => {
  it('reads shards, marking unassigned ones', () => {
    expect(
      parseShards(
        '[{"index":"a","shard":"0","prirep":"p","state":"STARTED","docs":"10","store":"2048","node":"n1"},{"index":"a","shard":"0","prirep":"r","state":"UNASSIGNED","docs":null,"store":null,"node":null,"unassigned.reason":"INDEX_CREATED"}]',
      ),
    ).toEqual([
      {
        index: 'a',
        shard: 0,
        primary: true,
        state: 'STARTED',
        node: 'n1',
        docs: 10,
        storeBytes: 2048,
      },
      {
        index: 'a',
        shard: 0,
        primary: false,
        state: 'UNASSIGNED',
        node: null,
        docs: null,
        storeBytes: null,
        unassignedReason: 'INDEX_CREATED',
      },
    ]);
  });

  it('summarises an allocation explanation', () => {
    const body = JSON.stringify({
      index: 'a',
      shard: 0,
      primary: false,
      current_state: 'unassigned',
      unassigned_info: { reason: 'INDEX_CREATED', at: '2026-09-30T00:00:00Z' },
      can_allocate: 'no',
      allocate_explanation:
        "Elasticsearch isn't allowed to allocate this shard to any of the nodes",
      node_allocation_decisions: [
        {
          node_name: 'es1',
          node_decision: 'no',
          deciders: [
            {
              decider: 'same_shard',
              decision: 'NO',
              explanation: 'a copy of this shard is already allocated to this node',
            },
            { decider: 'disk_threshold', decision: 'YES', explanation: 'enough disk' },
          ],
        },
      ],
    });
    expect(parseAllocationExplain(body)).toEqual({
      index: 'a',
      shard: 0,
      primary: false,
      currentState: 'unassigned',
      explanation: "Elasticsearch isn't allowed to allocate this shard to any of the nodes",
      canAllocate: 'no',
      unassignedReason: 'INDEX_CREATED',
      decisions: [
        {
          node: 'es1',
          decision: 'no',
          reasons: ['same_shard: a copy of this shard is already allocated to this node'],
        },
      ],
      raw: body,
    });
  });

  it('reads watermarks with transient over persistent over defaults, and node disks', () => {
    const disk = parseDiskAllocation(
      JSON.stringify({
        persistent: { 'cluster.routing.allocation.disk.watermark.low': '80%' },
        transient: { 'cluster.routing.allocation.disk.watermark.low': '70%' },
        defaults: {
          'cluster.routing.allocation.disk.threshold_enabled': 'true',
          'cluster.routing.allocation.disk.watermark.low': '85%',
          'cluster.routing.allocation.disk.watermark.high': '90%',
          'cluster.routing.allocation.disk.watermark.flood_stage': '0.95',
        },
      }),
      '[{"shards":"12","disk.indices":"100","disk.used":"5000","disk.avail":"5000","disk.total":"10000","disk.percent":"50","node":"es1"},{"shards":"3","node":"UNASSIGNED"}]',
    );
    expect(disk).toEqual({
      thresholdEnabled: true,
      low: '70%',
      high: '90%',
      floodStage: '0.95',
      nodes: [
        {
          node: 'es1',
          shards: 12,
          diskUsedBytes: 5000,
          diskAvailableBytes: 5000,
          diskTotalBytes: 10000,
          diskPercent: 50,
        },
      ],
      unassignedShards: 3,
    });
    // The nested form the server sends by default, with dotted keys inside `watermark` and a
    // node setting from elasticsearch.yml among the defaults.
    const nested = parseDiskAllocation(
      '{"persistent":{"cluster":{"routing":{"allocation":{"disk":{"watermark":{"high":"88%"}}}}}},"defaults":{"cluster":{"routing":{"allocation":{"disk":{"threshold_enabled":"false","watermark":{"flood_stage.max_headroom":"100GB","flood_stage":"95%","high":"90%","low":"85%","low.max_headroom":"200GB"}}}}}}}',
      '[]',
    );
    expect(nested).toMatchObject({
      thresholdEnabled: false,
      low: '85%',
      high: '88%',
      floodStage: '95%',
      maxHeadroom: { low: '200GB', floodStage: '100GB' },
    });
    expect(watermarkPercent('85%')).toBe(85);
    expect(watermarkPercent('0.95')).toBe(95);
    expect(watermarkPercent('500mb')).toBeUndefined();
  });
});

describe('named resources', () => {
  it('maps kinds to paths, lifecycle to ILM or ISM', () => {
    expect(resourcePath('index-template', 'ilm', 'logs')).toBe('/_index_template/logs');
    expect(resourcePath('lifecycle-policy', 'ilm', 'hot')).toBe('/_ilm/policy/hot');
    expect(resourcePath('lifecycle-policy', 'ism', 'hot')).toBe('/_plugins/_ism/policies/hot');
    expect(() => resourcePath('lifecycle-policy', null)).toThrow();
    expect(
      resourcePutRequest('lifecycle-policy', 'ism', 'p', '{}', { seqNo: 3, primaryTerm: 1 }),
    ).toEqual({
      method: 'PUT',
      path: '/_plugins/_ism/policies/p',
      query: 'if_seq_no=3&if_primary_term=1',
      body: '{}',
    });
  });

  it('reads composable templates without read-only fields, hiding dot names', () => {
    const list = parseResources(
      'index-template',
      'ilm',
      JSON.stringify({
        index_templates: [
          {
            name: 'logs',
            index_template: {
              index_patterns: ['logs-*'],
              priority: 200,
              composed_of: ['base'],
              data_stream: {},
              template: { settings: { number_of_shards: 1 } },
              created_date_millis: 1,
            },
          },
          { name: '.hidden', index_template: { index_patterns: ['.x'] } },
        ],
      }),
    );
    expect(list).toEqual([
      {
        kind: 'index-template',
        name: 'logs',
        summary: [
          { label: 'Index patterns', value: 'logs-*' },
          { label: 'Priority', value: '200' },
          { label: 'Composed of', value: 'base' },
          { label: 'Data stream', value: 'yes' },
        ],
        body: '{"index_patterns":["logs-*"],"priority":200,"composed_of":["base"],"data_stream":{},"template":{"settings":{"number_of_shards":1}}}',
      },
    ]);
  });

  it('reads ILM and ISM policies as their PUT bodies', () => {
    const ilm = parseResources(
      'lifecycle-policy',
      'ilm',
      '{"hot-warm": {"version": 2, "modified_date": "x", "policy": {"phases": {"hot": {}, "delete": {}}}, "in_use_by": {"indices": ["a", "b"]}}}',
    );
    expect(ilm[0]).toMatchObject({
      name: 'hot-warm',
      body: '{"policy":{"phases":{"hot":{},"delete":{}}}}',
      summary: [
        { label: 'Phases', value: 'hot, delete' },
        { label: 'Used by', value: '2 indices' },
        { label: 'Version', value: '2' },
      ],
    });
    const ism = parseResources(
      'lifecycle-policy',
      'ism',
      '{"policies": [{"_id": "p1", "_seq_no": 4, "_primary_term": 1, "policy": {"policy_id": "p1", "description": "d", "last_updated_time": 1, "schema_version": 1, "default_state": "hot", "states": [{"name": "hot"}, {"name": "delete"}]}}], "total_policies": 1}',
    );
    expect(ism[0]).toEqual({
      kind: 'lifecycle-policy',
      name: 'p1',
      summary: [
        { label: 'Description', value: 'd' },
        { label: 'Default state', value: 'hot' },
        { label: 'States', value: 'hot, delete' },
      ],
      body: '{"policy":{"description":"d","default_state":"hot","states":[{"name":"hot"},{"name":"delete"}]}}',
      seqNo: 4,
      primaryTerm: 1,
    });
  });

  it('reads pipelines and repositories', () => {
    expect(
      parseResources(
        'ingest-pipeline',
        'ilm',
        '{"clean": {"description": "Tidy", "processors": [{"trim": {"field": "a"}}, {"lowercase": {"field": "b"}}]}}',
      )[0]!.summary,
    ).toEqual([
      { label: 'Description', value: 'Tidy' },
      { label: 'Processors', value: 'trim, lowercase' },
    ]);
    expect(
      parseResources(
        'snapshot-repository',
        null,
        '{"backups": {"type": "fs", "settings": {"location": "/snap"}}}',
      ),
    ).toEqual([
      {
        kind: 'snapshot-repository',
        name: 'backups',
        summary: [
          { label: 'Type', value: 'fs' },
          { label: 'Location', value: '/snap' },
        ],
        body: '{"type":"fs","settings":{"location":"/snap"}}',
      },
    ]);
  });
});

describe('snapshots', () => {
  it('lists snapshots newest first', () => {
    const list = parseSnapshots(
      JSON.stringify({
        snapshots: [
          {
            snapshot: 'old',
            uuid: 'u1',
            state: 'SUCCESS',
            indices: ['b', 'a'],
            data_streams: [],
            start_time_in_millis: 1788220800000,
            end_time_in_millis: 1788220801000,
            duration_in_millis: 1000,
            shards: { total: 2, failed: 0, successful: 2 },
          },
          {
            snapshot: 'new',
            state: 'IN_PROGRESS',
            indices: ['a'],
            start_time_in_millis: 1788307200000,
            shards: { total: 1, failed: 0 },
          },
        ],
      }),
    );
    expect(list.map((s) => s.snapshot)).toEqual(['new', 'old']);
    expect(list[1]).toEqual({
      snapshot: 'old',
      uuid: 'u1',
      state: 'SUCCESS',
      indices: ['a', 'b'],
      dataStreams: [],
      startedAt: '2026-09-01T00:00:00.000Z',
      endedAt: '2026-09-01T00:00:01.000Z',
      durationMs: 1000,
      shardsTotal: 2,
      shardsFailed: 0,
    });
  });

  it('builds snapshot and restore bodies, and predicts restored names', () => {
    expect(snapshotBody({ indices: ['a', 'b-*'] })).toBe(
      '{"indices": "a,b-*", "include_global_state": false, "ignore_unavailable": true}',
    );
    expect(
      restoreBody({ indices: ['a'], renamePattern: '(.+)', renameReplacement: 'restored-$1' }),
    ).toBe(
      '{"indices": "a", "rename_pattern": "(.+)", "rename_replacement": "restored-$1", "include_global_state": false, "include_aliases": false}',
    );
    expect(restoredNames(['a', 'b'], '(.+)', 'restored-$1')).toEqual(['restored-a', 'restored-b']);
    expect(restoredNames(['a'], undefined, undefined)).toEqual(['a']);
    expect(restoredNames(['a'], '(', 'x')).toBeUndefined();
  });
});

describe('pipeline simulation', () => {
  it('wraps bare documents', () => {
    expect(
      simulateBody('{"processors": []}', '[{"a": 1}, {"_source": {"b": 2}, "_id": "x"}]'),
    ).toBe(
      '{"pipeline": {"processors":[]}, "docs": [{"_source":{"a":1}}, {"_source":{"b":2},"_id":"x"}]}',
    );
    expect(simulateBody(undefined, '{"a": 1}')).toBe('{"docs": [{"_source":{"a":1}}]}');
  });

  it('reads plain and verbose results', () => {
    const plain = parseSimulation(
      '{"docs": [{"doc": {"_index": "i", "_source": {"a": 12345678901234567890}}}, {"error": {"type": "x", "reason": "bad"}}]}',
    );
    expect(plain).toEqual([
      { source: '{"a": 12345678901234567890}', dropped: false, processors: [] },
      { error: 'bad', dropped: false, processors: [] },
    ]);
    const verbose = parseSimulation(
      JSON.stringify({
        docs: [
          {
            processor_results: [
              { processor_type: 'set', status: 'success', doc: { _source: { a: 1 } } },
              {
                processor_type: 'fail',
                tag: 't',
                status: 'error',
                error: { type: 'fail_processor_exception', reason: 'nope' },
              },
            ],
          },
          { processor_results: [{ processor_type: 'drop', status: 'dropped' }] },
        ],
      }),
    );
    expect(verbose[0]).toEqual({
      error: 'nope',
      dropped: false,
      processors: [
        { processor: 'set', status: 'success', source: '{"a":1}' },
        { processor: 'fail', tag: 't', status: 'error', error: 'nope' },
      ],
    });
    expect(verbose[1]).toMatchObject({ dropped: true });
  });
});
