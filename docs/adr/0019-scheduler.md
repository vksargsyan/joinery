# 0019. The scheduler: jobs run from main while Querybara is open

- Status: Accepted; staying open in the tray superseded by [0021](0021-confirm-closing-with-schedules.md)
- Date: 2026-09-30

## Context

The spec's scheduler and automation run backups, SQL files, exports and saved comparisons on a
schedule, with a history of runs and notifications when something needs attention. Two places
could run them. The app could run them while it is open. Or the OS could run them, with launchd,
Task Scheduler or cron starting `querybara-cli` when the app is closed.

The OS route runs when the app is closed. But it has to reach saved passwords outside the app's
secure storage, it is set up differently on each OS, and it needs a second way to report
results. The in-app route reuses everything that already runs these jobs:

- the job runner process (ADR 0006), and its checks: the connection's write rules, file grants,
  secrets resolved in main;
- the sync service for comparisons (ADR 0009);
- the desktop notifications.

Everything, jobs included, was already running in main without the renderer.

## Decision

**The scheduler lives in main, while Querybara is open.**

- **The scheduler engine** (`main/scheduler.ts`):
  - It keeps each enabled schedule's `nextRunAt`.
  - It wakes at the soonest one, and at least every minute, so a sleep or a clock change is
    noticed. It also wakes on `powerMonitor` resume and unlock.
  - It runs what is due through the task executor.
  - A run more than two minutes late was missed (the app was closed, the computer asleep). Each
    schedule says whether a missed run is caught up once or skipped.
  - A schedule still running when it is due again skips that run.
  - Every run is recorded, skipped ones included, and runs a crashed session left going are
    marked failed at start.
  - Timers and the clock are injected, so tests drive it.
- **Rules are local time** (`@querybara/core` `schedule.ts`): every N minutes or hours, times on
  chosen weekdays, or days of the month (including the last). A time in a daylight-saving gap runs
  at the first minute after it; a repeated hour runs once. Rules describe themselves in words and
  preview their next runs.
- **Storage** (migration 6) has two tables:
  - `schedules`, each on a connection or a saved comparison, and deleted with it. Edits are
    versioned; the scheduler's `nextRunAt` is not.
  - `schedule_runs`, the newest 200 kept per schedule.
- **Tasks are the wizards' jobs** (`schedules.ts` in `@querybara/ipc`):
  - A backup, a Run SQL File, or an export, minus the output path. Each run writes a new file named
    from a template with `{name}`, `{date}` and `{time}`. It never overwrites (`-2`, `-3`), and it
    can keep only the newest N. Pruning deletes only names the template can produce, in the
    schedule's folder.
  - A comparison schedule runs its saved comparison. It writes the HTML report (structure) or the
    sync script (data) only when it finds differences, and flags the run.
  - A scheduled export's query takes no bound parameters, since no one is there to fill them in.
- **The same rules as a manual job** (`schedule-tasks.ts`):
  - Runs go through `checkJobSafety`. A SQL file on a production or confirm-writes connection is
    confirmed once, when it is scheduled.
  - Secrets are resolved with `requireAll`, so a password that is not available fails the run
    with what to do. Available means saved, or typed in this session.
  - An encrypted backup's passphrase lives in the secret store under the schedule's id, never in
    the schedule.
  - Saving a schedule checks that its folder (or SQL file) was picked in a dialog in this window
    (the file grants of ADR 0006). Main trusts the stored paths from then on.
  - Scheduled jobs start `silent`, so the job manager does not notify on top of the scheduler.
- **Notifications** are per schedule: when a run fails or finds differences (the default), after
  every run, or never. A click opens Querybara.
- **Staying open.** On Windows and Linux, closing the last window with schedules on keeps
  Querybara in the tray, with Open, Pause schedules and Quit. Opening Querybara again opens its
  window. macOS apps keep running without windows already.
- **The UI:**
  - The Schedules panel lists each schedule with its switch, next run and last result. The
    selected one shows what it does, when, where it writes, what would make it fail, Run now, Edit
    and Delete, and its run history with each run's message and files.
  - Schedules are made where the job is set up once: Schedule… in the Backup dialog, the export
    wizard, Run SQL File and the saved comparisons.
  - The schedule editor has the rule, with its preview, then output, retention, notifications,
    and a passphrase when needed.

## Consequences

- Schedules do not run while Querybara is closed. Missed runs are caught up once (or skipped) when
  it starts, and the editor and the panel say so. Running when closed would be a later
  "system task" option for a schedule. It would install an OS entry that calls `querybara-cli`,
  which needs the same saved secrets.
- Scheduled runs appear in the Jobs panel like any other job, and in the schedule's history.
- A run needs its connection's password available without asking, meaning saved, or typed
  earlier in the session. The panel warns about a schedule whose password is not saved.
- Deleting a schedule leaves the files its runs wrote.
