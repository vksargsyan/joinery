# 0004. Desktop process wiring: MessagePorts into the page, the app:// scheme, bundled packaging

- Status: Accepted
- Date: 2026-09-29

## Context

The spec (§3, §18) splits the desktop app into a main process, a sandboxed preload, a React
renderer without Node.js, and one Electron utility process per open connection. The renderer
talks typed, zod-validated RPC (`@joinery/ipc`) to main, and directly to each connection host
so result rows never pass through main. Secrets go from main to hosts only.

Three constraints shape the wiring:

- `contextBridge` cannot carry a `MessagePort`, and a sandboxed preload cannot hand the page
  anything but cloneable values and functions.
- The main contract has streams (Test Connection, connection events), progress events and
  cancellation. `ipcRenderer.invoke` offers none of these.
- The page needs a real origin: CSP `'self'`, module workers for Monaco, and origin checks on
  forwarded ports. `file://` gives it an opaque one, and granting file:// extra privileges is
  what the `GrantFileProtocolExtraPrivileges` fuse exists to turn off.

## Decision

**Every RPC channel is a MessagePort.** The page asks for the main contract with
`window.joinery.requestMainPort()`; the preload sends a hello on one IPC channel. Main answers
only its own window's main frame on the app origin: it creates a `MessageChannelMain`, serves
`mainContract` on one end with `serve` (which validates every message with zod) and transfers
the other end with `webContents.postMessage('joinery:port', { kind: 'main' }, [port])`. Each
page load gets a fresh channel; the previous server is disposed.

`openConnection` does the same for a connection host: main attaches one end of a new channel to
the host (a validated `attach` control message on the utility process's parent port) and sends
the other to the page tagged `{ kind: 'connection', connectionId }`. Calling it again for a
connected profile joins the running host and hands out another port, which is how the page
reconnects after a host crash.

**The preload forwards ports without interpreting them.** It checks the payload shape and that
exactly one port came with it, then re-posts it to its own window:
`window.postMessage({ joinery: 'port', kind, connectionId? }, location.origin, [port])`. The page
accepts a port only when `event.source === window`, `event.origin === location.origin`, the data
has exactly that shape and one port is attached. Ports may arrive before or after the RPC reply
that asked for them, so the page keeps them until claimed. The bridge exposes nothing else but
platform and version strings.

**Main ↔ host control runs over the parent port**, with zod schemas on both ends
(`src/shared/host-protocol.ts`): `connect` / `check` (carrying the ResolvedProfile), `attach`,
`shutdown` one way; `ready`, `failed`, `check-step`, `check-done` the other. Nothing on it ever
travels towards the renderer. Sessions belong to the port that opened them and close with it.

**The renderer is served from `app://joinery/`**, a privileged standard, secure scheme. The
handler maps paths inside `out/renderer` only (encoded and dot-dot escapes are refused), serves
known file types, and adds the CSP header to every response; the same policy is written into
index.html as a meta tag by the build. In development the Vite dev server gets the header
through `session.webRequest`, and a request filter cancels anything that is not the app itself.

**Everything is bundled.** electron-vite builds main and the connection host (one CommonJS
build with two entries), the preload (one CommonJS file, as sandboxed preloads require) and the
renderer. Workspace packages and third-party code, the drivers included, are compiled in, so
`apps/desktop` has only devDependencies and electron-builder packs `out/` alone into an ASAR
with the fuses from spec §18. Optional modules the drivers never load here (`pg-native`) and
`dt-sql-parser` (editor diagnostics only) stay external.

## Consequences

- Streams, progress, cancellation and validation behave identically for main and for hosts;
  the renderer uses one RPC client type for both.
- The preload is a dozen lines with no logic worth attacking, and no `ipcRenderer` method is
  reachable from the page.
- A crashed host closes its ports, so the page learns about it without polling; main's
  `connectionEvents` stream adds the restart and failure states.
- Packaging needs no native rebuilds and no node_modules pruning. The cost is a larger main
  bundle and that `pnpm audit --prod` does not see the app's bundled dependencies (the
  packages that declare them are audited instead).
- Chromium's `--no-sandbox` switch disables the OS sandbox of every process and aborts start-up
  when combined with `app.enableSandbox()`. Main therefore skips `enableSandbox()` only when
  that switch is present, which only the e2e launcher passes, and only when running as root.
  Windows keep `sandbox: true` in their web preferences either way.
