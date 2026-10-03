import { bindParameters } from '@querybara/sql-tools';
import { describe, expect, it } from 'vitest';

import {
  buildRunPlan,
  describeReason,
  parameterValues,
  type RunRequest,
} from '../src/renderer/src/state/run-plan';

const open = { readOnly: false, production: false, confirmWrites: false };

function plan(text: string, overrides: Partial<RunRequest> = {}) {
  return buildRunPlan({ text, dialect: 'postgres', mode: 'all', policy: open, ...overrides });
}

describe('run plans', () => {
  const script = 'select 1;\nupdate t set a = 1;\n\ndelete from t where id = 3;';

  it('runs every statement with absolute offsets for Run all', () => {
    const { statements } = plan(script);
    expect(statements.map((s) => s.text)).toEqual([
      'select 1',
      'update t set a = 1',
      'delete from t where id = 3',
    ]);
    for (const statement of statements) {
      expect(script.slice(statement.start, statement.end)).toBe(statement.text);
    }
    expect(statements.map((s) => s.index)).toEqual([0, 1, 2]);
  });

  it('runs the statement at the cursor, or the one before it in the gap', () => {
    expect(plan(script, { mode: 'statement', cursor: 15 }).statements.map((s) => s.text)).toEqual([
      'update t set a = 1',
    ]);
    // On the blank line after the update: still the update.
    expect(plan(script, { mode: 'statement', cursor: 29 }).statements.map((s) => s.text)).toEqual([
      'update t set a = 1',
    ]);
    expect(plan('', { mode: 'statement', cursor: 0 }).statements).toEqual([]);
  });

  it('runs the selection, split and mapped back to the editor', () => {
    const start = script.indexOf('update');
    const end = script.length;
    const selected = plan(script, { mode: 'selection', selection: { start, end } });
    expect(selected.statements.map((s) => s.text)).toEqual([
      'update t set a = 1',
      'delete from t where id = 3',
    ]);
    expect(script.slice(selected.statements[1]!.start, selected.statements[1]!.end)).toBe(
      'delete from t where id = 3',
    );
    // An empty selection falls back to the statement at the cursor.
    expect(
      plan(script, { mode: 'selection', selection: { start: 3, end: 3 } }).statements.map(
        (s) => s.text,
      ),
    ).toEqual(['select 1']);
  });

  it('asks before risky statements and lists why', () => {
    const risky = plan('update t set a = 1;\ndrop table t;\nselect 1;');
    expect(risky.refused).toBeUndefined();
    expect(risky.confirmations.map((c) => [c.statement.index, c.reasons])).toEqual([
      [0, ['update-without-where']],
      [1, ['drop']],
    ]);
    expect(describeReason('update-without-where')).toContain('every row');
  });

  it('asks before every write on production and refuses writes when read-only', () => {
    const production = plan('insert into t values (1); select 1', {
      policy: { readOnly: false, production: true, confirmWrites: true },
    });
    expect(production.confirmations.map((c) => c.reasons)).toEqual([['write']]);

    const readOnly = plan('select 1; delete from t where id = 1', {
      policy: { readOnly: true, production: false },
    });
    expect(readOnly.refused?.index).toBe(1);
    expect(
      plan('select 1', { policy: { readOnly: true, production: true } }).refused,
    ).toBeUndefined();
  });

  it('collects parameters once per name and per statement for positional ones', () => {
    const named = plan('select :id; select * from t where id = :id and x = :x');
    expect(named.parameters.map((p) => p.label)).toEqual([':id', ':x']);
    expect(named.statements[1]!.parameters.map((p) => p.key)).toEqual([':id', ':x']);

    const numbered = plan('select $1, $2; select $1');
    expect(numbered.parameters.map((p) => p.label)).toEqual([
      '$1 (statement 1)',
      '$2 (statement 1)',
      '$1 (statement 2)',
    ]);
    const mysql = buildRunPlan({
      text: 'select ?, ?',
      dialect: 'mysql',
      mode: 'all',
      policy: open,
    });
    expect(mysql.parameters.map((p) => p.label)).toEqual(['? #1', '? #2']);
    // `?` is a jsonb operator in PostgreSQL, not a placeholder.
    expect(plan(`select '{"a":1}'::jsonb ? 'a'`).parameters).toEqual([]);
  });

  it('reports mixed placeholder styles before running, at the offending placeholder', () => {
    const text = 'select 1;\nselect :a, $1';
    const mixed = plan(text);
    expect(mixed.problem?.message).toMatch(/Cannot mix/);
    expect(text.slice(mixed.problem!.position!, mixed.problem!.position! + 2)).toBe('$1');
  });

  it('binds prompted values in the driver form', () => {
    const { statements } = plan('select * from t where id = :id and name = :name or id = :id');
    const answers = new Map<string, null | string>([
      [':id', '42'],
      [':name', null],
    ]);
    const values = parameterValues(statements[0]!, answers);
    expect(values).toEqual({ id: '42', name: null });
    expect(bindParameters(statements[0]!.text, 'postgres', values)).toEqual({
      text: 'select * from t where id = $1 and name = $2 or id = $1',
      values: ['42', null],
    });
    const numbered = plan('select $2, $1').statements[0]!;
    expect(
      parameterValues(
        numbered,
        new Map([
          ['0:$1', 'a'],
          ['0:$2', 'b'],
        ]),
      ),
    ).toEqual(['a', 'b']);
    expect(parameterValues(plan('select 1').statements[0]!, new Map())).toBeUndefined();
  });
});
