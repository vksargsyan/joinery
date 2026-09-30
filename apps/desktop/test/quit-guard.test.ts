import { describe, expect, it } from 'vitest';

import {
  QuitGuard,
  quitQuestion,
  whenText,
  type GuardedSchedule,
  type QuitAnswer,
  type QuitQuestion,
} from '../src/main/quit-guard';

const NOW = new Date(2026, 8, 30, 14, 0);

const schedule = (name: string, extra: Partial<GuardedSchedule> = {}): GuardedSchedule => ({
  name,
  enabled: true,
  nextRunAt: new Date(2026, 9, 1, 2, 0).toISOString(),
  running: false,
  ...extra,
});

/** A guard whose question is answered by the test. */
function setup(schedules: GuardedSchedule[], platform: NodeJS.Platform = 'win32') {
  const asked: { question: QuitQuestion; window: string | undefined }[] = [];
  let answer: (value: QuitAnswer) => void = () => undefined;
  const state = { enabled: true, paused: false, quits: 0, stopped: 0 };
  const guard = new QuitGuard<string>({
    platform,
    enabled: () => state.enabled,
    paused: () => state.paused,
    schedules: () => schedules,
    ask: (question, window) => {
      asked.push({ question, window });
      return new Promise((resolve) => (answer = resolve));
    },
    stopAsking: () => state.stopped++,
    quit: () => state.quits++,
    now: () => NOW,
  });
  const reply = async (value: QuitAnswer): Promise<void> => {
    answer(value);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { guard, asked, state, reply };
}

describe('quitQuestion', () => {
  it('names the schedule and its next run, in local time', () => {
    const question = quitQuestion([schedule('Nightly backup')], 'darwin', NOW)!;
    expect(question.message).toBe('Quit Joinery? Schedules don’t run while it’s closed.');
    expect(question.detail).toBe(
      'The schedule “Nightly backup” is on; its next run is tomorrow at 02:00.\n\n' +
        'Runs missed while Joinery is closed are caught up, or skipped, as each schedule says, when it opens again.',
    );
    expect(question.buttons).toEqual(['Quit Joinery', 'Cancel']);
    expect(question.checkboxLabel).toBe('Don’t ask again');
  });

  it('counts several, names the soonest, and warns about runs going now', () => {
    const question = quitQuestion(
      [
        schedule('Weekly export', { nextRunAt: new Date(2026, 9, 5, 3, 0).toISOString() }),
        schedule('Hourly check', {
          nextRunAt: new Date(2026, 8, 30, 15, 0).toISOString(),
          running: true,
        }),
        schedule('Off', { enabled: false, nextRunAt: null }),
      ],
      'linux',
      NOW,
    )!;
    expect(question.message).toBe('Close Joinery? Schedules don’t run while it’s closed.');
    expect(question.detail.split('\n\n').slice(0, 2)).toEqual([
      '2 schedules are on; the next, “Hourly check”, is due today at 15:00.',
      '“Hourly check” is running now and will be stopped.',
    ]);
    expect(question.buttons).toEqual(['Close Joinery', 'Cancel']);
  });

  it('asks nothing when no schedule is on', () => {
    expect(quitQuestion([schedule('Off', { enabled: false })], 'win32', NOW)).toBeUndefined();
    expect(quitQuestion([], 'win32', NOW)).toBeUndefined();
  });

  it('says when a run is further off', () => {
    expect(whenText(new Date(2026, 9, 5, 3, 7), NOW)).toBe('Mon 5 Oct at 03:07');
    expect(whenText(new Date(2027, 0, 4, 9, 30), NOW)).toBe('Mon 4 Jan 2027 at 09:30');
    // A run already due counts as today.
    expect(whenText(new Date(2026, 8, 30, 13, 59), NOW)).toBe('today at 13:59');
  });
});

describe('QuitGuard', () => {
  it('holds the last window open while it asks, then quits when confirmed', async () => {
    const { guard, asked, state, reply } = setup([schedule('Nightly backup')]);
    expect(guard.lastWindowClosing('main')).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.window).toBe('main');
    // Closing again while the question is up asks nothing more.
    expect(guard.lastWindowClosing('main')).toBe(false);
    expect(guard.beforeQuit('main')).toBe(false);
    expect(asked).toHaveLength(1);

    await reply({ confirmed: true, dontAskAgain: false });
    expect(state.quits).toBe(1);
    expect(state.stopped).toBe(0);
    // The quit that follows, and its windows closing, go through.
    expect(guard.beforeQuit('main')).toBe(true);
    expect(guard.lastWindowClosing('main')).toBe(true);
  });

  it('stays open when cancelled, and asks again next time', async () => {
    const { guard, asked, state, reply } = setup([schedule('Nightly backup')], 'darwin');
    expect(guard.beforeQuit(undefined)).toBe(false);
    await reply({ confirmed: false, dontAskAgain: true });
    expect(state.quits).toBe(0);
    // "Don't ask again" counts only with the confirmation.
    expect(state.stopped).toBe(0);
    expect(guard.beforeQuit(undefined)).toBe(false);
    expect(asked).toHaveLength(2);
  });

  it("remembers Don't ask again", async () => {
    const { guard, state, reply } = setup([schedule('Nightly backup')]);
    guard.beforeQuit('main');
    await reply({ confirmed: true, dontAskAgain: true });
    expect(state).toMatchObject({ quits: 1, stopped: 1 });
  });

  it('lets macOS close its windows without asking: only quitting asks', () => {
    const { guard, asked } = setup([schedule('Nightly backup')], 'darwin');
    expect(guard.lastWindowClosing('main')).toBe(true);
    expect(asked).toHaveLength(0);
  });

  it('never asks with the setting off, schedules paused or off, or once bypassed', () => {
    const off = setup([schedule('Nightly backup')]);
    off.state.enabled = false;
    expect(off.guard.beforeQuit('main')).toBe(true);

    const paused = setup([schedule('Nightly backup')]);
    paused.state.paused = true;
    expect(paused.guard.beforeQuit('main')).toBe(true);

    const none = setup([schedule('Off', { enabled: false })]);
    expect(none.guard.lastWindowClosing('main')).toBe(true);

    const shutdown = setup([schedule('Nightly backup')]);
    shutdown.guard.bypass();
    expect(shutdown.guard.beforeQuit('main')).toBe(true);
    expect(shutdown.guard.lastWindowClosing('main')).toBe(true);
    for (const { asked } of [off, paused, none, shutdown]) expect(asked).toHaveLength(0);
  });

  it('quits when the question cannot be shown, rather than trap the user', async () => {
    let quits = 0;
    const guard = new QuitGuard<string>({
      platform: 'win32',
      enabled: () => true,
      paused: () => false,
      schedules: () => [schedule('Nightly backup')],
      ask: () => Promise.reject(new Error('no display')),
      stopAsking: () => undefined,
      quit: () => quits++,
    });
    expect(guard.beforeQuit('main')).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(quits).toBe(1);
    expect(guard.beforeQuit('main')).toBe(true);
  });
});
