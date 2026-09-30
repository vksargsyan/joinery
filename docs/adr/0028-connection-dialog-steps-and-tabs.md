# 0028. The connection dialog in two steps and tabs; TLS off by default

- Status: Accepted
- Date: 2026-10-01

## Context

The connection dialog was one long form. It held the name, engine, endpoint, sign-in, engine
options, TLS, the SSH tunnel with its jump hosts, the proxy, and presentation, so most of it was
off screen.

The engine was a select in the middle of that form. Switching engines kept the sign-in method
when the new engine also offered it. As a result:

- A new Redis or Elasticsearch connection started with password authentication.
- Elasticsearch started with basic authentication over https.
- Every connection started with TLS on and fully verified.

Most servers people add first (local, in a private network, in a container) have no TLS, so the
first Test Connection usually failed at the TLS step.

Navicat solves the layout with two steps: the connection type, then the settings in tabs.

## Decision

**Step 1: the engine** (`components/connection/EnginePicker.tsx`). A new connection starts here.
There is one card per engine, showing its pictogram, family and default port.

- The engine of the connection saved last is picked; with no connections yet, PostgreSQL is
  picked.
- A search narrows the cards.
- Arrows move between cards. Enter, a double-click or Next goes on.
- Pasting a URI here fills the form and goes straight to it, since the URI names the engine.
- Editing or duplicating a connection skips this step. The form's header shows the engine; Back
  returns to the cards and keeps what was typed.

**Step 2: the form, in tabs** (`components/ConnectionDialog.tsx`). The dialog keeps one size
across tabs and steps.

| Tab      | Holds                                                                                                                                           |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| General  | Name, how to connect, the endpoint, sign-in and its storage, environment, folder                                                                |
| Advanced | MongoDB's default database, read preference and direct connection; Redis's database number and key delimiter; read-only, confirm writes, colour |
| TLS      | Mode, certificates, the weak-TLS warning                                                                                                        |
| SSH      | The tunnel and its jump hosts                                                                                                                   |
| Proxy    | SOCKS5 or HTTP proxy                                                                                                                            |

- Every tab stays mounted, so hidden fields keep their state and still validate.
- A tab holding an invalid field shows a red dot.
- Save and Test Connection open the first such tab and put the cursor in the field.
- TLS, SSH and Proxy show a green dot while they are on.
- The URI button reopens the paste box on General.

**Defaults:**

- **TLS off** for every new connection: the form, core's profile schema, and URIs that state
  nothing, in the app and the CLI.
- **What turns TLS on:**
  - A URI's `sslmode`, `ssl-mode`, `ssl` or `tls`.
  - `rediss://`, `https://` and `mongodb+srv://`. An SRV record implies TLS, as in MongoDB
    drivers.
  - Choosing an SRV record or an Elastic Cloud ID in the form.
- **Sign-in:** MongoDB, Redis and Elasticsearch start without it, and Elasticsearch's first node
  URL is `http://localhost:9200`.
- **Switching engines:** a sign-in left at the old engine's default, with no user or password
  typed, takes the new engine's default.

**The weak-TLS warning** (spec §4) now marks only a connection that crosses a network with TLS
off or not fully verified (`hasWeakTls`, `isLocalEndpoint` in core). It no longer shows for:

- localhost and loopback addresses, and `*.localhost` names;
- a Unix socket;
- loopback at the far end of an SSH tunnel, whose own leg is encrypted.

A proxy without a tunnel carries the traffic over the network, so it still warns there. On the
TLS tab, a local server gets a note in place of the warning.

## Consequences

- End-to-end tests pick the engine (`chooseEngine`) and open tabs (`connectionTab`) before
  touching a field there. The TLS and proxy selects are labelled "TLS mode" and "Proxy type", so
  their labels do not collide with the tab panels named after the tabs.
- Imported profiles and URIs without TLS settings now connect without TLS, where they used to
  require verified TLS.
