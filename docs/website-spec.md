# Build the Joinery website: landing page, searchable documentation, real screenshots and data-flow motion graphics

You are building the public website for **Joinery**. The site has four parts:

1. A landing page.
2. Complete documentation with fast search.
3. Real screenshots of the product.
4. Animated diagrams that show how data moves through Joinery and the databases it manages.

Work autonomously through the milestones in §12. Stop and ask only for the decisions listed in §14.

---

## 0. Paths and names

| Name                  | Value                                                     |
| --------------------- | --------------------------------------------------------- |
| Product repo (exists) | `~/My/joinery` (GitHub: `vksargsyan/joinery`)             |
| Website repo (new)    | `~/My/joinery-website`, a sibling of the product repo     |
| Download source       | `https://github.com/vksargsyan/joinery/releases`          |
| Site URL              | read from `SITE_URL` env, default `http://localhost:4321` |

- Create the website repo with `git init -b main`.
- Commit after each milestone, using conventional commits.
- **Do not** create a GitHub remote, push, or deploy. The user will do that.

---

## 1. What Joinery is: read these sources first, invent nothing

Joinery is a cross-platform desktop database manager (Electron, React, TypeScript).

- **Engines:** MySQL, MariaDB, PostgreSQL, MongoDB, Redis/Valkey and Elasticsearch, all in one app.
- **CLI:** a headless CLI, `joinery`, runs the same engine.
- **Version:** read it from `apps/desktop/package.json` on `main` (a **beta**). Always work from `main`; other branches can be far behind.

Before writing anything, read the following in `~/My/joinery`:

- `README.md`. The "What works today" section is the feature inventory.
- `docs/adr/*.md`. These say how things work: process model, tunnels, job runner, sync, query builder, ER diagrams, search module, packaging.
- `docs/releasing.md`. Covers installers, platforms, update channels, staged rollout and the managed-fleet policy switch.
- `docs/backup-archive-format.md`. The `.jbak` format.
- `apps/desktop/src/renderer/src/components/**`. Take **exact UI labels** (menu items, buttons, dialog titles, tab names) from here. Grep for a label before you use it in a how-to step.
- `apps/cli/src/**` (commander program). Covers commands, flags and env vars (`JOINERY_STORE`, `JOINERY_BACKUP_PASSPHRASE`, …).
- `apps/desktop/build/icon.svg` and `apps/desktop/src/renderer/src/styles.css`. These hold the brand mark and the app's theme tokens.
- `apps/desktop/e2e/**`. The Playwright-for-Electron harness you will reuse for screenshots (`app.ts`, `db.ts`, `mongo-db.ts`, `redis.ts`, `search.ts`; existing specs already have a `shot()` helper driven by `JOINERY_E2E_SHOTS`).
- `AGENTS.md`. Follow it in the product repo.

Rules for accuracy:

- **Traceability.** Every statement on the site must trace back to one of these sources.
- **Unverified behaviour.** If you can't confirm a behaviour from code, docs or a run of the app, leave it out. Never pad.
- **Unreleased features** (cloud sync of connections and credentials, for one) never appear on the site: no roadmap page, no teaser, no "coming soon". Never mention a feature that is not in "What works today".
- **Banned content:**
  - invented metrics, benchmarks, user counts, testimonials or customer logos
  - pricing
  - comparisons that name competitor products
  - licence claims: the repo has no LICENSE file, so don't call Joinery "open source" or name a licence
  - lorem ipsum

---

## 2. Tech stack

- **Framework:** **Astro** with **Starlight** for the docs. The landing page is a fully custom Astro page that shares the design tokens; it is not Starlight's splash template.
- **Search:** **Pagefind**, which is built into Starlight. Static, works offline, no external service.
- **Tooling:** TypeScript strict, pnpm, Node 22 (match the product repo's `.nvmrc`), Prettier, ESLint, `astro check`.
- **Motion:** hand-built inline SVG animated with **Motion** (motion.dev) or GSAP. Pick one and use it everywhere. Lottie, video files and canvas aren't allowed for the core animations (see §7).
- **Fonts:** self-hosted variable fonts via `@fontsource-variable/*`. No runtime calls to Google Fonts or any other third party.
- **Privacy:** no analytics, cookies or trackers.
- **Hosting:** static output. Include a GitHub Pages workflow (`.github/workflows/deploy.yml`), but leave it unused.
- **Versions:** install current stable versions. Read each tool's docs for the version you installed; don't rely on memory, because APIs change between majors.
- **Departures:** you may switch away from this stack only for a concrete blocker. If you do, explain why in the website README.

---

## 3. Design direction: "utterly beautiful", made testable

**Concept: precision joinery.** Fine hairlines, an exact grid, and parts that interlock, like the joined cylinder of the logo. A small dovetail is the one recurring motif, used for section dividers and list markers. Never use wood textures, woodgrain or clip art.

**Brand palette.** Derive it from the product:

- **The app's design system is Kiln** (ADR 0025): Tenmoku (dark) and Bisque (light), rust as the only accent, the other glazes (celadon, ochre, red, cobalt, lilac) carrying meaning. Take the exact values from `styles.css` and `lib/kiln.ts`.
- **Logo:** the joined-cylinder icon (ADR 0032), `apps/desktop/build/icon.svg`.
- **App light theme:** bg `#f6f7f9`, panel `#ffffff`, fg `#1a1e24`, accent `#2f6fec`.

**Tokens.** Define every colour, space, radius, shadow and duration as a CSS custom property in one tokens file. Both the landing page and the Starlight theme override use that file. Components never use raw hex values.

**Themes.** Dark is the default, because the app is dark-first. A light theme is also required.

- Follow the OS setting until the user picks a theme with the toggle, then remember their choice.
- No flash of the wrong theme on load.
- Screenshots and animations switch with the theme (§6, §7).

**Typography.**

- Families: one display family, one text family and one monospace family. All three must be variable fonts and subsetted.
- Type scale: a modular scale.
- Line length: 60–75ch for body text.
- Numerals: tabular figures in tables and code.

**Layout.**

- Spacing: an 8 px spacing scale and a 12-column grid.
- Breakpoints: 360, 768, 1024, 1280 and 1536 px.
- No horizontal scroll at any width from 360 to 2560 px.

**Screenshot presentation.** Every screenshot sits in one consistent window frame: rounded corners, a hairline border and a soft layered shadow, all drawn in CSS (not baked into the image). In docs, clicking a screenshot opens a zoomable lightbox.

**Motion rules (whole site).**

- Animate only `transform` and `opacity`.
- Durations: 150–400 ms for UI, with one easing family.
- No scroll-jacking and no parallax on text.
- `prefers-reduced-motion` turns all non-essential motion off (see §7 for the diagrams).

**Quality bar.** Aim for the polish of a top-tier developer-tool site: Linear, Raycast, Vercel, Tailwind. Check yourself by looking at your own screenshots of the built site:

- Is every alignment exact?
- Is every gap on the scale?
- Is there exactly one primary action per view?
- Is anything decorative but meaningless?

Fix whatever fails these checks.

---

## 4. Landing page (`/`)

Build these sections in order. Each feature section shows a real screenshot (§6) or a motion piece (§7) and links to its docs page.

1. **Navigation bar.** It is sticky and turns translucent on scroll. It holds:
   - the logo (`icon.svg`) with the "Joinery" wordmark
   - links: Docs, CLI, Download, GitHub
   - a search button showing `⌘K` / `Ctrl K`, which opens the same Pagefind search as the docs
   - the theme toggle
2. **Hero.**
   - A headline and a one-sentence subhead: one app for six engines, plus a CLI.
   - A "Beta · v{version}" pill.
   - A primary CTA, **Download for {detected OS}**, and a secondary CTA, **Read the docs**. The primary CTA links to `releases/latest`. If OS detection fails, link to the releases page instead.
   - The hero screenshot: a PostgreSQL query tab with results.
3. **Engines.** Six engine tiles with one line each on what Joinery does for that engine. Use text wordmarks or neutral glyphs, not third-party logos.
   - The **M1 "one app, every engine"** animation (§7) runs behind or beside the tiles.
4. **Feature showcase.** Each item gets a screenshot or animation plus 2–4 tight bullets:
   - Query editor, autocomplete and visual explain
   - Visual query builder
   - ER diagrams and model editing
   - Table data editing and table designer
   - MongoDB: query builder, aggregation editor, SQL tab and code export
   - Redis/Valkey: key browser, editors, CLI and dashboards
   - Elasticsearch: console, documents, SQL/ES|QL and administration
   - Server tools: monitor, sessions, top queries and grants
5. **Data in motion.** A section built on the motion pieces, with a short caption each:
   - **M4** cross-engine transfer
   - **M5** structure sync
   - **M8** backup and restore
6. **Secure by default.**
   - SSH (jump hosts, a shared session, `known_hosts` checks)
   - SOCKS5/HTTP proxies
   - TLS in four modes, up to verify-full (off by default; a URI's sslmode, rediss://, https:// or mongodb+srv:// turns it on)
   - passwords in the OS keychain
   - confirmations for risky writes and production profiles
   - sandboxed renderer
   - AES-256-GCM encrypted backups
   - Pair this section with the **M3** tunnel animation.
7. **CLI.**
   - A terminal block of real commands from the README, with a copy button. Typing animation is allowed, but the static text must be present in the HTML.
   - The line: "Same engine, headless".
   - A link to the CLI reference.
8. **Download.**
   - Platform cards:
     - macOS: universal DMG
     - Windows: NSIS, MSI and zip, for x64 and arm64
     - Linux: AppImage, deb and rpm, for x64 and arm64
   - Notes on stable and beta update channels.
   - The honest note that test builds are unsigned, and how to open them on macOS.
9. **Footer.** Docs sections, GitHub, Releases and a "Built from Joinery {version} @ {short SHA}" line.

Copy tone: confident, concrete, short. Every sentence names a real capability. No superlatives the product can't back up.

---

## 5. Documentation (`/docs/...`)

### 5.1 Information architecture (sidebar)

**Getting started**

- Overview
- Install (per OS, unsigned builds, updates and channels)
- Your first connection
- Tour of the interface (sidebar, dock and tabs, themes)
- Keyboard shortcuts (extracted from source)

**Connections**

- Profiles (host/port, socket, URI)
- TLS modes
- Passwords and keychain
- Import from URI and pgpass
- Encrypted profile export
- Test Connection
- Production profiles and environment colours
- SSH tunnels (auth methods, jump hosts, keep-alives, host keys)
- Proxies
- Replica sets, Sentinel and Cluster through tunnels

**SQL: MySQL, MariaDB, PostgreSQL**

- Query editor (run modes, `DELIMITER` and dollar quoting, parameters, write confirmations, cancel, transactions, history, autosave and crash recovery)
- Autocomplete
- Results grid
- Visual explain
- Visual query builder
- Table data:
  - filtering and paging
  - grid, form and JSON views
  - editing and applying changes
  - foreign keys
  - copy and paste
  - saved views
- Table designer
- ER diagrams: viewing, editing the model, review and apply

**MongoDB**

- Connecting (SRV, SCRAM, LDAP, X.509)
- Explorer
- Collection view and query bar
- Visual query builder
- Document editor
- Bulk update and delete
- Explain
- Aggregation editor
- Indexes
- Schema analysis and validators
- Change streams
- GridFS
- Users and roles
- Command console
- SQL tab
- Export query as code

**Redis and Valkey**

- Standalone, Sentinel, Cluster and ACL
- Key browser
- Value editors (one section per type)
- TTL, rename and copy
- Bulk delete with dry run
- CLI
- Pub/Sub
- Monitoring: INFO, slow log, clients, latency, MONITOR, big keys
- ACL users
- Configuration editor
- Topology

**Elasticsearch**

- Connecting (node URLs, Cloud ID, auth)
- Explorer
- Console
- Documents
- SQL and ES|QL
- Index operations
- Mappings and reindex
- Cluster: health, nodes, shards, disk watermarks, tasks
- Aliases and templates
- ILM
- Ingest pipelines
- Snapshots

**Moving data**

- Structure sync
- Data compare
- Data transfer (each engine pair)
- Import
- Export
- Run SQL file
- Jobs
- Backup and restore

**Server tools**

- Monitor
- Sessions
- Top queries
- Users, roles and grants
- Maintenance
- Settings

**CLI reference**

- Installing and running
- Global options and env vars
- One page per command: `test`, `query`, `compare`, `data-compare`, `ddl`, `import`, `export`, `run-file`, `transfer`, `profiles`, `backup`, `restore`
- Exit codes

**Reference**

- Supported engines and versions: take the tested versions from the CI matrix in `.github/workflows/ci.yml`
- Feature matrix by engine
- The `.jbak` archive format
- How Joinery works: the process model, with animation **M9**
- Security model
- Data and settings locations
- Updates, channels, staged rollout and managed-fleet policy
- Troubleshooting and FAQ

### 5.2 Page template

Every feature page follows this order:

1. A one-paragraph "what it is".
2. **Engine badges** showing where the feature is available.
3. A screenshot or motion piece.
4. Task-oriented how-tos as numbered steps using exact UI labels.
5. Options and settings tables.
6. Safety notes as callouts: what the feature confirms, what can lose data.
7. CLI equivalent, where one exists.
8. Related pages.

Frontmatter carries `title`, `description`, `engines: [...]` and `keywords: [...]`.

### 5.3 Generated content

These must stay in sync with the product, so generate them with scripts in the website repo that read `../joinery`:

- **CLI reference.** `scripts/sync-cli.ts` builds the CLI (`pnpm --filter @joinery/cli build`), runs `joinery <cmd> --help` for every command, and writes MDX pages from the output. Hand-written explanation and examples go in clearly separated sections around the generated part.
- **Version and commit.** `scripts/sync-meta.ts` writes `src/data/joinery.json` with the desktop version, the short SHA, engine versions from the CI matrix, and the date.
- **CLI output in docs.** Real output captured from runs against the demo databases (§6.3), pasted as text, not images.

### 5.4 Coverage check

Add `scripts/coverage.ts` and wire it into `pnpm check`. It:

- maps every bullet of README "What works today" to the page(s) that cover it, and fails if a bullet has no page
- fails if an unreleased feature (the script keeps the list) is mentioned on any page

---

## 6. Screenshots: real captures only

### 6.1 Non-negotiables

- **Real product only.** Every screenshot comes from the real Joinery app, built from `~/My/joinery` at its current commit. Never mock, redraw, AI-generate, composite or retouch UI.
- **Allowed post-processing:** crop, resize and compression. Frames and shadows are added in CSS.
- **If a shot can't be captured** (Docker missing, a flow broken), don't fake it. Use a clearly labelled placeholder, then list the shot and the reason in the final report.
- **No private data.** No real hostnames, IPs, user names, emails, tokens or home-directory paths may appear in any shot. Check file dialogs, title bars and connection lists.

### 6.2 Capture harness (lives in the product repo)

- **Branch.** Add the harness to `~/My/joinery` on a new branch, `docs/website-screenshots`. This is the only change you make in the product repo. No product code changes.
- **Location and config.** It lives in `apps/desktop/e2e/screenshots/`:
  - `screenshots.config.ts` (Playwright config with `testMatch: '*.shots.ts'`, so it never runs with the e2e suite)
  - one `*.shots.ts` file per area
  - a `package.json` script, `shots`
- **Reuse the existing helpers.** Use `launchApp` from `e2e/app.ts` and the DB helpers. Extend `launchApp` with an optional `args` (non-breaking) so you can pass `--force-device-scale-factor=2`.
- **Window size.** Fix the content size at **1440×900** via `BrowserWindow.setContentSize`, captured at 2× scale.
- **Themes.** Capture every shot in **both themes** by setting the app's Theme setting to Dark, then Light.
- **Linux.** On Linux, run under `xvfb-run -a`.
- **Product repo rules.** The harness must pass the repo's `pnpm check` (strict TS, no `any`, ESLint, Prettier). Commit it with conventional commits. Don't push.
- **Output.** Write to `JOINERY_E2E_SHOTS=~/My/joinery-website/screenshots/raw/{dark,light}/`.
- **Optimiser.** A website script, `scripts/optimize-shots.ts`, converts the raw shots into `src/assets/screenshots/` and updates `src/data/screenshots.json`. Each entry holds:
  - `id`
  - `alt` (describes what is on screen)
  - `caption`
  - `engine`
  - `pages`
  - `capturedAt`
  - `joineryVersion`
  - `joinerySha`
- **Rendering.** Astro's `<Picture>` renders AVIF and WebP with a PNG fallback, responsive `srcset`, and explicit width and height. Images below the fold load lazily.
- **One-command regeneration.** `pnpm shots` in the website repo starts the demo databases, runs the harness, optimises the output and stops the databases.

### 6.3 Demo data: one fictional company across every engine

- **Infrastructure.** Add `docker-compose.demo.yml` with the engine versions CI tests on pull requests (PostgreSQL 16, MySQL 8.4, MariaDB 11.4, MongoDB 8.0, Redis 7.4 or Valkey 8, Elasticsearch 9.x), plus an OpenSSH bastion container for the tunnel shots.
- **Seed.** Seed one coherent, obviously fictional business, for example **"Larchwood Furniture Co."**, an online furniture workshop. The same story then runs through every engine and every animation:

| Engine        | Demo content                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL    | `shop` schema: `customers`, `products`, `orders`, `order_items`, `suppliers`, `inventory`, `shipments`, with FKs, a view, a few thousand orders |
| MySQL/MariaDB | `shop_eu` copy with a few deliberate schema differences, so structure sync has something to show                                                |
| MongoDB       | `catalog.products` with embedded reviews and variants, `events` time series, a GridFS bucket of product images                                  |
| Redis         | `session:*` with TTLs, `cart:*` hashes, `leaderboard:*` sorted sets, `orders:stream` with a consumer group, a RedisJSON key if available        |
| Elasticsearch | a `products` index with mappings, a `logs-shop-*` data stream, an alias and an ILM policy                                                       |

- **Names and addresses.** Use `example.com` emails and hostnames such as `db.internal.example`.
- **Connection profiles.** Name them like "Shop · production" (with the production colour), "Shop · staging" and "Catalog · Mongo".

### 6.4 Shot list (minimum)

Name each file `<id>.png`. Capture it in both themes.

| id                   | Scene                                                                       | Used on                    |
| -------------------- | --------------------------------------------------------------------------- | -------------------------- |
| `hero-query`         | PostgreSQL query tab, a join over orders/customers, results streaming       | Landing hero, Query editor |
| `connection-dialog`  | New connection, SSH tab with a jump host                                    | Connections, SSH           |
| `connection-test`    | Stepwise Test Connection, all steps green                                   | Test Connection            |
| `host-key-prompt`    | Trust prompt for a new SSH host key                                         | SSH                        |
| `autocomplete`       | Completion list with columns resolved through an alias                      | Autocomplete               |
| `explain`            | Explain Analyze plan tree, slowest node highlighted                         | Visual explain             |
| `query-builder`      | Tables on the canvas, join from FK, criteria panel, SQL in step             | Landing, Query builder     |
| `er-diagram`         | Shop schema, one table selected with its relationships                      | Landing, ER diagrams       |
| `er-model-apply`     | Edit model → Review & apply script with a data-loss flag                    | ER model editing           |
| `table-data`         | Editable grid, filter builder, a staged edit                                | Landing, Table data        |
| `table-apply`        | The SQL preview before applying staged changes                              | Table data                 |
| `table-designer`     | Columns and indexes tabs, save script with warnings                         | Table designer             |
| `structure-sync`     | `shop` vs `shop_eu` diff, destructive ops unticked, side-by-side definition | Landing, Structure sync    |
| `data-compare`       | Row differences after a data compare                                        | Data compare               |
| `transfer-mapping`   | SQL → MongoDB transfer, embedding order items                               | Data transfer              |
| `import-preview`     | CSV/Excel import with live preview and auto-matched columns                 | Import                     |
| `export`             | Export wizard with format options                                           | Export                     |
| `jobs`               | Job list with progress, one finished, one running                           | Jobs                       |
| `backup` / `restore` | Backup to an encrypted `.jbak`; restore with selected objects               | Landing, Backup            |
| `server-monitor`     | Monitor charts after a minute of synthetic load                             | Landing, Server tools      |
| `sessions`           | Sessions list with cancel/terminate                                         | Server tools               |
| `top-queries`        | Top queries with reason and fix                                             | Server tools               |
| `grants`             | Grants matrix                                                               | Users and roles            |
| `mongo-collection`   | Collection view, query bar, tree and table views                            | Landing, MongoDB           |
| `mongo-builder`      | Visual query builder in step with find()                                    | MongoDB query builder      |
| `mongo-aggregation`  | Aggregation editor with per-stage previews                                  | Landing, Aggregation       |
| `mongo-schema`       | Schema analysis                                                             | Schema analysis            |
| `mongo-sql`          | SQL tab translating SELECT → aggregate()                                    | SQL tab                    |
| `mongo-code-export`  | Query exported as Python or Node.js                                         | Export as code             |
| `redis-browser`      | Namespace tree, a hash open in the editor, TTL shown                        | Landing, Redis             |
| `redis-stream`       | Stream with consumer group and pending entries                              | Value editors              |
| `redis-cli`          | CLI with autocomplete and inline docs                                       | Redis CLI                  |
| `redis-info`         | INFO dashboard / slow log                                                   | Monitoring                 |
| `redis-topology`     | Cluster topology (start a 3-node cluster for this shot)                     | Topology                   |
| `es-console`         | Console with API autocomplete                                               | Landing, Elasticsearch     |
| `es-documents`       | Document grid with an edit                                                  | Documents                  |
| `es-sql`             | SQL with Translate to DSL / ES\|QL                                          | SQL and ES\|QL             |
| `es-cluster`         | Shard allocation with its explanation                                       | Cluster                    |

Add more shots wherever a docs page would otherwise have no visual.

---

## 7. Motion graphics: how data flows through Joinery and the databases

Animated, theme-aware diagrams that make the invisible parts of Joinery visible: where queries go, how rows stream back, how data changes shape between engines. They serve as explanations first and decoration second.

### 7.1 Accuracy

Each animation depicts the **real mechanism** as described in the ADRs and source code. No made-up steps.

- **Storyboard first.** Before animating, write a storyboard in `motion/<id>.md`:
  - each step
  - what moves
  - the on-screen caption
  - the ADR or source file that proves the step
- **Demo data in particles.** The particles that move are labelled with demo-data values: a row `#1042 Oak dining table`, a document `{ _id, items: [...] }`, a key `cart:8812`. They show real shapes of data, not abstract dots.

### 7.2 Pieces (storyboard outlines; verify each against the sources)

| id     | Title                 | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                    | Placement                             |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| **M1** | One app, every engine | Joinery at the centre. Queries flow out to the six engines; results flow back and settle into a grid. Calm, looping, ambient.                                                                                                                                                                                                                                                                                                                    | Landing, engines section              |
| **M2** | Life of a query       | Editor → statement splitter (cuts on `;`, respects `DELIMITER` and dollar quoting) → safety check (a risky write on a production profile raises a confirmation) → the connection's own host process → optional SSH tunnel → database. Rows stream **straight back to the page, not through the main process**, in 1,000-row batches into the canvas grid. A final beat: Cancel sends a server-side cancel. Sources: README "Querying", ADR 0004. | Docs: Query editor; How Joinery works |
| **M3** | Through the bastion   | Laptop → jump host → bastion → database over **one shared SSH session** used by all of a connection's tabs. A host key is checked against `known_hosts`: new → trust prompt, changed → blocking warning. Variant: a MongoDB replica set or Redis Cluster reached node by node through the loopback SOCKS5 route. Source: ADR 0008.                                                                                                               | Landing, security; Docs: SSH          |
| **M4** | Changing shape        | Cross-engine transfer in three panels: **SQL → MongoDB**: `orders` rows plus their `order_items` (joined through the FK) fold into one document with an embedded array. **MongoDB → SQL**: a document flattens into columns; its array becomes a child table, or a JSON column. **SQL → SQL**: the type mapping applies, data streams first, then keys, indexes and FKs are added. A short Redis → Redis coda shows DUMP/RESTORE carrying TTLs.  | Landing; Docs: Data transfer          |
| **M5** | Sync to zero          | Two schemas side by side → a diff of create/alter/drop operations (destructive ones arrive **unticked**) → a dependency-ordered script → apply (the script is verified against the reviewed one; one transaction on PostgreSQL) → re-compare → "0 differences". Source: ADR 0009.                                                                                                                                                                | Landing; Docs: Structure sync         |
| **M6** | Checksums, not rows   | Data compare: the source key space is walked in ranges, and a checksum per range is computed **on each server**. Matching ranges fade away without moving a row. A mismatched range is **bisected** until it holds ≤1,000 rows; only those rows stream to Joinery to be compared, and then a sync script is generated. Checksums are on by default only when both sides are the same engine family. Source: `packages/sync/src/data/compare.ts`. | Docs: Data compare                    |
| **M7** | Import pipeline       | A CSV or Excel file → format, delimiter and encoding detected → live preview → columns auto-matched, types inferred → mode chosen (append/update/upsert/…) → rows stream in the **job runner process**, with a progress bar; one bad row is set aside with its row, line and column. Cancel rolls back. Source: ADR 0006.                                                                                                                        | Docs: Import; Jobs                    |
| **M8** | Backup and restore    | A PostgreSQL/MySQL database read in one consistent snapshot (with MongoDB collections plus their indexes, and Redis keys plus their TTLs, as variants) → a `.jbak` archive assembling one file per object, sealed with AES-256-GCM when a passphrase is set → restore of selected objects into another database, with "what would be dropped" listed first.                                                                                      | Landing; Docs: Backup                 |
| **M9** | How Joinery works     | The process model: React renderer (no Node.js) ↔ main over a MessagePort; the renderer ↔ **one connection-host utility process per open connection** directly; the job runner started on demand; secrets travel only main → hosts/runner. Interactive: hover a process to highlight its channels.                                                                                                                                                | Docs: How Joinery works               |

### 7.3 Craft and behaviour

**Rendering.**

- Inline SVG, drawn in the site's visual language (hairlines, the grid, Kiln glazes for each kind of data).
- Colours come only from tokens, so each piece re-themes instantly with dark/light.
- Each piece weighs at most ~30 KB gzipped (SVG plus its script).

**Timing.**

- 8–20 s per loop, broken into named steps.
- Captions under the diagram change in step with the animation.
- Hold 2 s on the final state before looping.

**Playback.**

- Playback starts when the piece is ≥50 % in the viewport. It pauses when the piece is off-screen or the tab is hidden.
- Every piece has a visible **pause/play** control, as WCAG 2.2.2 requires.
- Docs versions also get **Prev/Next step** controls and a step indicator, so readers can walk the flow at their own pace.

**Reduced motion and accessibility.**

- Under `prefers-reduced-motion: reduce`, show the final state as a static, numbered diagram with all captions visible.
- Each piece is a `<figure>`. The steps are also an ordered list inside a `<figcaption>`, readable by screen readers and indexed by search.

**Performance.**

- 60 fps on a mid-range laptop.
- No layout shift: reserve the box.
- Animate transforms and opacity only.

**Video exports (optional).** Run `scripts/record-motion.ts` to record each piece in both themes with Playwright into `public/media/motion/<id>-{dark,light}.{webm,mp4}` plus a poster PNG, for READMEs and social posts. The site itself keeps using the live SVG versions.

**Gallery.** A dev-only page, `/dev/motion`, shows every piece in both themes and in reduced-motion mode, so you can review them side by side.

---

## 8. Search

**Engine.** Pagefind via Starlight, indexing every docs page. It covers headings, body, frontmatter `keywords`, CLI flags, error messages quoted in troubleshooting, and the `<figcaption>` step lists of the motion pieces.

**Opening search.**

- `⌘K` / `Ctrl K` and `/` open it from anywhere, including the landing page.
- `Esc` closes it.

**Results.**

- The full list is keyboard-navigable with ↑ ↓ ↵.
- Each result shows the page title, the matching **section heading** and a highlighted excerpt.
- Each result deep-links to that heading.

**Engine filter.** Expose `engines` from frontmatter as a Pagefind filter (PostgreSQL, MySQL, MariaDB, MongoDB, Redis, Elasticsearch, CLI).

**Synonyms.** Map these through `keywords` or Pagefind meta:

- pg / postgres → PostgreSQL
- mongo → MongoDB
- es / elastic → Elasticsearch
- valkey → Redis
- bastion / jump host → SSH
- dump → backup
- diff / migrate → structure sync
- csv / xlsx → import

**Empty state.** Suggest popular pages.

**Tests.** `tests/search.spec.ts`, a Playwright test against the built site, asserts that each of these queries puts the expected page in the **top 3** results:

| Query                | Expected page        |
| -------------------- | -------------------- |
| `ssh jump host`      | SSH tunnels          |
| `known_hosts`        | SSH tunnels          |
| `pgpass`             | Import from URI      |
| `explain analyze`    | Visual explain       |
| `foreign key lookup` | Table data           |
| `aggregation`        | Aggregation editor   |
| `gridfs`             | GridFS               |
| `sentinel`           | Redis connections    |
| `slow log`           | Redis monitoring     |
| `es\|ql`             | SQL and ES\|QL       |
| `reindex`            | Mappings and reindex |
| `upsert`             | Import               |
| `jbak`               | `.jbak` format       |
| `encrypt backup`     | Backup and restore   |
| `--continue`         | `run-file`           |
| `JOINERY_STORE`      | Global options       |
| `postgres compare`   | Structure sync       |
| `ttl`                | Redis TTL            |
| `staged rollout`     | Updates              |
| `parquet`            | Export               |

---

## 9. Website repo structure

```
joinery-website/
  astro.config.mjs
  package.json                 # scripts: dev, build, preview, check, shots, sync, record-motion
  docker-compose.demo.yml
  demo/seed/{postgres,mysql,mongodb,redis,elasticsearch}/…
  scripts/{sync-cli,sync-meta,optimize-shots,coverage,record-motion}.ts
  screenshots/raw/{dark,light}/      # git-ignored
  src/
    styles/tokens.css
    components/{landing,docs,motion,ui}/…
    components/motion/{M1…M9}.astro
    content/docs/…               # MDX, IA from §5.1
    assets/screenshots/{dark,light}/…
    data/{joinery.json,screenshots.json}
    pages/index.astro
  motion/<id>.md                 # storyboards with sources
  tests/{search,a11y,links,visual}.spec.ts
  public/{favicon.svg,og/…,media/motion/…}
  .github/workflows/deploy.yml   # GitHub Pages, not run
  README.md                      # run, build, regenerate screenshots, sync content, deploy
```

---

## 10. SEO, social and metadata

- Every page has a unique `<title>` and meta description, a canonical URL from `SITE_URL`, a `sitemap.xml` and a `robots.txt`.
- Generate an Open Graph image per page at build time: the logo, the page title and the section name, in brand colours.
- Favicons and the touch icon come from `icon.svg`.
- Add a `SoftwareApplication` JSON-LD block on the landing page, with no rating or price fields.

---

## 11. Acceptance criteria (all must pass before you report done)

**Build and checks**

- `pnpm build` passes with zero warnings.
- `pnpm check` passes `astro check`, typecheck, ESLint, Prettier, `coverage.ts` and the link checker (no broken internal links or anchors).
- The product repo's `pnpm check` passes on the `docs/website-screenshots` branch.

**Lighthouse** (mobile, landing and two docs pages, both themes)

- Performance ≥ 95
- Accessibility 100
- Best Practices 100
- SEO 100

**Accessibility**

- WCAG 2.2 AA: axe reports 0 violations in `tests/a11y.spec.ts`.
- Colour contrast meets AA in both themes.
- Focus is visible everywhere.
- Every image has meaningful alt text.
- Every animation can be paused and has a reduced-motion fallback.

**Layout**

- No horizontal scroll and no CLS > 0.02 at 360, 768, 1280 and 1920 px.
- `tests/visual.spec.ts` saves full-page screenshots of the landing page and three docs pages at those widths in both themes. Review them yourself and fix defects.

**Without JavaScript**

- The site still reads fully: content, images, static diagrams, navigation.
- Only search, the theme toggle and animation playback need JS.

**Search and coverage**

- All §8 search queries pass.
- Every README feature bullet is covered (`coverage.ts`).
- No unreleased feature is mentioned.

**Assets**

- Every §6.4 shot exists in both themes, or appears in the report as not captured, with the reason.
- Every §7.2 motion piece exists, with a storyboard that cites its sources.

---

## 12. Milestones (commit after each)

1. **Inventory.** Read the sources in §1. Write `docs-plan.md` in the website repo: the IA from §5.1 mapped to sources, the feature inventory, and open questions.
2. **Scaffold and design system.** Set up Astro + Starlight, tokens, typography, both themes and the theme toggle. Build the window frame, callouts, engine badges and the lightbox.
3. **Demo data and screenshot harness.** Write the compose file and seeds. Build the harness in the product repo (on its own branch). Run the first full capture, then optimise it.
4. **Docs content.** Generate the CLI reference and meta, then write every page in §5.1.
5. **Motion graphics.** Write storyboards M1–M9, build them, and set up the `/dev/motion` gallery.
6. **Landing page.**
7. **Search tuning.** Add synonyms and filters, and get the search tests passing.
8. **QA.** Run every check in §11, fix what fails, re-run, and write the final report.

---

## 13. Final report

End with a short report that covers:

- **Paths:** both repos, the branches, and the commits made.
- **How to use it:**
  - run the dev server
  - build
  - regenerate screenshots (`pnpm shots`)
  - sync content (`pnpm sync`)
  - record motion videos
  - deploy
- **Results:** a table of every acceptance criterion with pass/fail and its evidence.
- **Gaps:** screenshots not captured, and claims left out because you couldn't verify them.
- **Open questions** for the user (§14).

---

## 14. Decisions to leave to the user (don't block on them; use the default and list them in the report)

| Question                                | Default                                  |
| --------------------------------------- | ---------------------------------------- |
| Licence: the repo has no LICENSE file   | Say nothing about licence or open source |
| Domain and hosting                      | GitHub Pages workflow present but unused |
| Pushing either repo / creating a remote | Don't                                    |
| Exact download asset names per OS       | Link to `releases/latest`                |
| Fictional company name for demo data    | "Larchwood Furniture Co."                |
