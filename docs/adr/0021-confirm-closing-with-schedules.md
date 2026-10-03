# 0021. Closing Querybara with schedules on asks first, instead of a tray

- Status: Accepted
- Date: 2026-09-30

## Context

Schedules run only while Querybara is open ([ADR 0019](0019-scheduler.md)). To keep them
running, 0019 kept Querybara in the system tray on Windows and Linux when its last window
closed with schedules on. Two other ways to cover a closed app were considered:

- Keep the tray. Closing the window does not close the app. That surprises people who expect
  a closed window to mean a closed app, and a tray icon is easy to miss (GNOME hides them).
- Run schedules from the operating system (launchd, Task Scheduler, systemd timers) through
  `querybara-cli`. That is three integrations to install and remove, plus saved secrets read
  outside the app.

Neither is needed: people who schedule jobs keep Querybara open, and those who close it only
need to know what closing it means.

## Decision

**Closing Querybara with schedules on asks first, on every platform; there is no tray.**

- The question comes before the quit (the menu, Cmd+Q, the Dock) and, on Windows and Linux,
  before the last window closes, which quits there. macOS apps keep running without windows,
  so closing a window there asks nothing.
- It says what closing means, from the schedules:
  - how many are on;
  - which runs next, and when (today, tomorrow, or a date, in local time);
  - which scheduled runs are going now, and will be stopped;
  - that runs missed while Querybara is closed are caught up or skipped, as each schedule says.

  Its buttons are Quit (Close on Windows and Linux) and Cancel.

- "Don't ask again", with a confirmation, turns the question off. It is the
  `schedules.confirmClose` setting, and the Schedules panel's "Ask before closing" switch turns
  it back on.
- It is never asked:
  - when no schedule is on, or schedules are paused;
  - when the system shuts down, restarts or logs out (`powerMonitor` `shutdown`, and Windows'
    session end events);
  - when Querybara restarts to install an update;
  - when the question cannot be shown: Querybara closes rather than keep the user from closing
    it.
- The logic is `main/quit-guard.ts`, apart from Electron: the question's text and when to ask
  are unit tested, and the end-to-end tests answer it with a stubbed message box.

## Consequences

- Closing Querybara closes it. Schedules then wait for the next start, as the schedule editor and
  the question both say.
- The tray, its Pause schedules item and its icon are gone. `Scheduler.setPaused` stays, for a
  later pause control.
- Running while closed remains possible later, as a per-schedule "system task" option (ADR
  0019, Consequences).
