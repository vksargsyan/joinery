# 0006. Long jobs in a job runner utility process, with host keys checked in main

- Status: Accepted
- Date: 2026-09-29

## Context

Imports, exports and Run SQL File (spec §12) read and write files of any size, run for minutes,
and must keep going while the user works in other tabs. The spec (§3) puts long jobs in their
own process, so a slow parse or a large gzip stream never stalls a connection host or main.

Two things from the SSH work (spec §4) apply to every process that opens database sessions:
tunnels are opened where the session lives, and only main can show a window to ask about an
unknown or changed SSH host key.

[ADR 0004](0004-desktop-ports-and-protocol.md) describes the main ↔ connection host wiring. This
record extends it; it does not change the port model.

## Decision

**One job runner utility process, started on demand.** Main's `JobManager` forks
`out/main/job-runner.cjs` (a third entry of the main build, next to `index` and
`connection-host`) when the first job or wizard request arrives, and shuts it down after 30 s
with nothing running. The runner runs jobs side by side, each on its own driver session and,
for a profile with SSH or a proxy, its own `TransportManager`. The session and its tunnel close
before the runner reports the job done. A runner that exits fails the jobs it was running; the
next job starts a new one.

**Main ↔ runner control runs over the parent port**, validated with zod on both ends
(`src/shared/job-protocol.ts`): `start` (with the ResolvedProfile), `cancel`, `request`,
`host-key-decision` and `shutdown` one way; `progress`, `log`, `done`, `response` and `host-key`
the other. Like a connection host's `connect`, only `start` carries secrets, and only towards the
runner. Main relays progress, logs and summaries to the page through the `jobs.events` stream of
the main contract; the page never talks to the runner directly, since job traffic is progress,
not result rows.

**The wizards' quick requests run in the runner too.** Preview, column auto-match and the
new-table plan need `@joinery/transfer`, which reads files with `node:fs` and cannot be bundled
into the sandboxed renderer. Main forwards them as `request` messages and checks each `response`
against the method's result schema before returning it.

**Files are granted, not named.** A job reads only files the window picked with `openFile` and
writes only where its `saveFile` or `openDirectory` dialog pointed (`FileGrants`, per window).
Main also applies the write rules before a job starts: an import on a read-only profile is
refused, and replace or delete modes, or any import on a production or confirm-writes profile,
need the page's explicit confirmation.

**Host keys are checked in main, for connection hosts and the runner alike.** A tunnel that
meets an SSH server sends `host-key` (host, port, key type and fingerprint) and waits. Main
checks the shared known_hosts file: a remembered key is trusted at once; for a new one main asks
the user (trust once, trust and remember, or cancel); a key that differs from the remembered one
is a blocking warning that offers no way to trust it short of removing the old key. A question
nobody answers in time counts as cancelled. The answer is `host-key-decision` (`trust` or
`reject`). The connection host protocol in `src/shared/host-protocol.ts` carries the same pair
of messages.

## Consequences

- A job survives closing its tab, and a crash in a job cannot take a connection host or main
  down with it. Several jobs share one process, so a runaway job can slow the others; a process
  per job would isolate them at the cost of a start-up per job.
- The main build now has three entries (main, connection host, job runner); ADR 0004's
  packaging notes apply to all three.
- Cancel is prompt: it aborts the job's signal, the transfer stops at the next batch, and an
  import rolls back its transaction.
- Job history (the last 50 jobs) and saved wizard settings are settings entries in the local
  store for now. A jobs table in `@joinery/storage` is the place for them once the scheduler
  needs queries over past runs.
- Host key trust lives in one place, with one prompt, whichever process opened the tunnel. The
  CLI checks the same known_hosts file itself.
