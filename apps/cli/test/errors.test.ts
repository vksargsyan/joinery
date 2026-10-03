import { QuerybaraError } from '@querybara/core';
import { describe, expect, it, vi } from 'vitest';

import { CliError, EXIT, InterruptedError, caretLines, formatError } from '../src/errors';
import { Interrupts } from '../src/interrupt';
import { Reporter } from '../src/reporter';
import { confirmStatement, describeReasons, type ConfirmState } from '../src/safety';
import type { Target } from '../src/target';
import { FakeSignals, MemoryStream, ScriptedPrompter } from './helpers';

describe('formatError', () => {
  it('prints message, detail, hint, SQLSTATE, engine code and 1-based position', () => {
    const error = new QuerybaraError({
      code: 'SQL_ERROR',
      message: 'syntax error at or near "form"',
      detail: 'line one\nline two',
      hint: 'Check the spelling',
      sqlState: '42601',
      engineCode: 1064,
      position: 9,
    });
    expect(formatError(error)).toEqual([
      'error: syntax error at or near "form"',
      '  detail: line one',
      '          line two',
      '  hint: Check the spelling',
      '  SQLSTATE 42601, code 1064, position 10',
    ]);
  });

  it('points at the error position inside the statement', () => {
    const error = new QuerybaraError({ code: 'SQL_ERROR', message: 'bad', position: 22 });
    const lines = formatError(error, {
      statement: {
        index: 3,
        text: 'select 1\nfrom t where x ==\n1',
        line: 7,
        column: 1,
        source: 'a.sql',
      },
    });
    expect(lines.slice(-3)).toEqual([
      '  at statement 3 (a.sql:7:1)',
      '  LINE 2: from t where x ==',
      `${' '.repeat(10 + 13)}^`,
    ]);
  });

  it('keeps long lines readable around the caret', () => {
    const text = `select ${'a, '.repeat(100)}oops`;
    const [line, caret] = caretLines(text, text.indexOf('oops'));
    expect(line!.length).toBeLessThan(130);
    expect(line![caret!.indexOf('^')]).toBe('o');
  });

  it('prints plain errors and non-errors', () => {
    expect(formatError(new Error('boom'))).toEqual(['error: boom']);
    expect(formatError('text')).toEqual(['error: text']);
    expect(formatError(new CliError('usage', { hint: 'do x' }))).toEqual([
      'error: usage',
      '  hint: do x',
    ]);
  });

  it('uses diff-style exit codes', () => {
    expect(EXIT).toEqual({ ok: 0, differences: 1, partial: 1, error: 2, interrupted: 130 });
  });
});

describe('Interrupts', () => {
  it('cancels the guarded work on the first Ctrl+C and stops hard on the second', async () => {
    const signals = new FakeSignals();
    const interrupts = new Interrupts(new Reporter(new MemoryStream()), 10_000);
    interrupts.listen(signals);
    const cancel = vi.fn();
    let release!: () => void;
    const work = interrupts.guard(
      cancel,
      () =>
        new Promise<void>((_resolve, reject) => {
          release = () => reject(new Error('cancelled by server'));
        }),
    );
    signals.interrupt();
    expect(cancel).toHaveBeenCalledOnce();
    release();
    await expect(work).rejects.toBeInstanceOf(InterruptedError);
    signals.interrupt();
    await expect(interrupts.hardStop).rejects.toBeInstanceOf(InterruptedError);
    interrupts.dispose();
    expect(signals.listeners).toBe(0);
  });

  it('stops at once when nothing can be cancelled, and after the grace period otherwise', async () => {
    const idle = new Interrupts(new Reporter(new MemoryStream()));
    idle.interrupt();
    await expect(idle.hardStop).rejects.toBeInstanceOf(InterruptedError);

    const slow = new Interrupts(new Reporter(new MemoryStream()), 5);
    void slow
      .guard(
        () => undefined,
        () => new Promise(() => undefined),
      )
      .catch(() => undefined);
    slow.interrupt();
    await expect(slow.hardStop).rejects.toBeInstanceOf(InterruptedError);
  });
});

describe('safety prompts', () => {
  const target = (environment: 'dev' | 'production', readOnlySource?: 'flag' | 'profile'): Target =>
    ({
      kind: 'profile',
      label: 'db',
      profile: { presentation: { environment } },
      secrets: {},
      policy: { readOnly: false, production: environment === 'production' },
      passwordKnown: true,
      ...(readOnlySource ? { readOnlySource } : {}),
    }) as unknown as Target;
  const deps = (
    prompter: ScriptedPrompter,
    yes = false,
    state: ConfirmState = { yesToAll: false },
  ) => ({
    yes,
    prompter,
    reporter: new Reporter(new MemoryStream()),
    state,
  });
  const statement = { index: 1, text: 'delete from t' };

  it('runs safe statements and refuses writes on read-only targets', async () => {
    await confirmStatement(
      { action: 'run' },
      statement,
      target('dev'),
      deps(new ScriptedPrompter(false)),
    );
    await expect(
      confirmStatement(
        { action: 'refuse', reason: 'read-only' },
        statement,
        target('dev', 'profile'),
        deps(new ScriptedPrompter(false), true),
      ),
    ).rejects.toMatchObject({
      code: 'READ_ONLY',
      hint: expect.stringContaining('locked read-only'),
    });
  });

  it('needs --yes without a terminal and asks with one', async () => {
    const decision = { action: 'confirm', reasons: ['delete-without-where'] } as const;
    await expect(
      confirmStatement(decision, statement, target('dev'), deps(new ScriptedPrompter(false))),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await confirmStatement(
      decision,
      statement,
      target('dev'),
      deps(new ScriptedPrompter(false), true),
    );

    const state = { yesToAll: false };
    const prompter = new ScriptedPrompter(true, { confirm: ['all'] });
    await confirmStatement(decision, statement, target('dev'), deps(prompter, false, state));
    await confirmStatement(
      decision,
      { index: 2, text: 'drop table x' },
      target('dev'),
      deps(prompter, false, state),
    );
    expect(prompter.asked).toEqual(['Run it?']);
  });

  it('explains why', () => {
    expect(describeReasons(['write'], target('production'))).toBe(
      'it writes to the production connection "db"',
    );
    expect(describeReasons(['drop', 'write'], target('dev'))).toBe(
      'it drops an object and its data; "db" asks before every write',
    );
  });
});
