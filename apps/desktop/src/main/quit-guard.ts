/**
 * Asks before Joinery closes while schedules are on (ADR 0021): they run only while it is
 * open. Closing the last window (Windows, Linux) or quitting (every platform: the menu, the
 * Dock, Cmd+Q) shows one question; confirming goes on with the quit, and "Don't ask again"
 * turns the question off (the Schedules panel turns it back on). A shutdown, a logout or an
 * update's restart never asks: nothing may hold those up.
 */

/** A schedule as the question describes it. */
export interface GuardedSchedule {
  readonly name: string;
  readonly enabled: boolean;
  /** ISO time of the next run, when planned. */
  readonly nextRunAt: string | null;
  readonly running: boolean;
}

export interface QuitQuestion {
  readonly message: string;
  readonly detail: string;
  /** Confirm first, then cancel. */
  readonly buttons: readonly [string, string];
  readonly checkboxLabel: string;
}

export interface QuitAnswer {
  readonly confirmed: boolean;
  readonly dontAskAgain: boolean;
}

export interface QuitGuardOptions<W> {
  readonly platform: NodeJS.Platform;
  /** The setting: ask at all. */
  readonly enabled: () => boolean;
  /** Schedules paused: none would run anyway. */
  readonly paused: () => boolean;
  readonly schedules: () => readonly GuardedSchedule[];
  /** Shows the question, over `window` when there is one. */
  readonly ask: (question: QuitQuestion, window: W | undefined) => Promise<QuitAnswer>;
  /** "Don't ask again" was ticked along with the confirmation. */
  readonly stopAsking: () => void;
  /** Quits for real once confirmed. */
  readonly quit: () => void;
  readonly now?: () => Date;
}

const pad = (n: number): string => String(n).padStart(2, '0');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A local time as the question says it: "today at 02:00", "tomorrow at 02:00", "Mon 6 Oct at 02:00". */
export function whenText(at: Date, now: Date): string {
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const day = (date: Date): number =>
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
  const days = day(at) - day(now);
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  const year = at.getFullYear() === now.getFullYear() ? '' : ` ${at.getFullYear()}`;
  return `${DAYS[at.getDay()]!} ${at.getDate()} ${MONTHS[at.getMonth()]!}${year} at ${time}`;
}

/** The question for these schedules, or undefined when none is on. */
export function quitQuestion(
  schedules: readonly GuardedSchedule[],
  platform: NodeJS.Platform,
  now: Date,
): QuitQuestion | undefined {
  const enabled = schedules.filter((schedule) => schedule.enabled);
  if (enabled.length === 0) return undefined;
  const verb = platform === 'darwin' ? 'Quit' : 'Close';
  const next = enabled
    .filter((schedule) => schedule.nextRunAt !== null)
    .sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!))[0];
  const on =
    enabled.length === 1
      ? `The schedule “${enabled[0]!.name}” is on`
      : `${enabled.length} schedules are on`;
  const due =
    next === undefined
      ? '.'
      : enabled.length === 1
        ? `; its next run is ${whenText(new Date(next.nextRunAt!), now)}.`
        : `; the next, “${next.name}”, is due ${whenText(new Date(next.nextRunAt!), now)}.`;
  const running = schedules.filter((schedule) => schedule.running);
  const stopped =
    running.length === 0
      ? []
      : [
          running.length === 1
            ? `“${running[0]!.name}” is running now and will be stopped.`
            : `${running.length} scheduled runs are going now and will be stopped.`,
        ];
  return {
    message: `${verb} Joinery? Schedules don’t run while it’s closed.`,
    detail: [
      `${on}${due}`,
      ...stopped,
      'Runs missed while Joinery is closed are caught up, or skipped, as each schedule says, when it opens again.',
    ].join('\n\n'),
    buttons: [`${verb} Joinery`, 'Cancel'],
    checkboxLabel: 'Don’t ask again',
  };
}

export class QuitGuard<W> {
  readonly #options: QuitGuardOptions<W>;
  #confirmed = false;
  #bypassed = false;
  #asking = false;

  constructor(options: QuitGuardOptions<W>) {
    this.#options = options;
  }

  /** Quits from now on without asking: a shutdown, a logout, an update's restart. */
  bypass(): void {
    this.#bypassed = true;
  }

  /** The question, if closing now should ask it. */
  #question(): QuitQuestion | undefined {
    const options = this.#options;
    if (this.#confirmed || this.#bypassed || !options.enabled() || options.paused()) {
      return undefined;
    }
    return quitQuestion(options.schedules(), options.platform, options.now?.() ?? new Date());
  }

  /**
   * App `before-quit`: true when the quit may go on. Otherwise the question is on screen and
   * the caller cancels this quit; confirming starts it again.
   */
  beforeQuit(window?: W): boolean {
    return this.#check(window);
  }

  /**
   * The last window is closing on Windows or Linux, which quits Joinery: true when it may
   * close. Otherwise the caller keeps it open while the question is asked over it.
   */
  lastWindowClosing(window: W): boolean {
    if (this.#options.platform === 'darwin') return true;
    return this.#check(window);
  }

  #check(window: W | undefined): boolean {
    if (this.#asking) return false;
    const question = this.#question();
    if (question === undefined) return true;
    this.#asking = true;
    void this.#options.ask(question, window).then(
      (answer) => {
        this.#asking = false;
        if (!answer.confirmed) return;
        if (answer.dontAskAgain) this.#options.stopAsking();
        this.#confirmed = true;
        this.#options.quit();
      },
      () => {
        // A question that cannot be shown must not keep Joinery from closing.
        this.#asking = false;
        this.#confirmed = true;
        this.#options.quit();
      },
    );
    return false;
  }
}
