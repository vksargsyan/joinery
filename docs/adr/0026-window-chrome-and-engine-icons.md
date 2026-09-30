# 0026. The window's chrome as VS Code draws it, and an icon for each database engine

- Status: Accepted
- Date: 2026-09-30

## Context

With the Kiln design system (ADR 0025), the app is to follow VS Code's UI signature:

- The window had the native title bar (traffic lights and "Joinery") above a second row of the
  app's own, which also said "Joinery" and held text buttons (New query, History, Compare,
  Schedules, Jobs, Light theme, About).
- The app's name belongs in the application menu, as a packaged build shows it. Under
  `pnpm dev`, macOS names that menu "Electron" (the dev run starts Electron's own bundle).
- Every connection in the tree had the same cylinder icon, so which database a connection is
  could only be read from its name.

## Decision

**The page draws the title bar; the native one is hidden** (`main/window-chrome.ts`,
`components/TitleBar.tsx`).

- **The bar:** 35px on the chrome ground, and dragging it moves the window.
  - **macOS:** the traffic lights are inset into it (`titleBarStyle: 'hidden'`,
    `trafficLightPosition`). The bar leaves them room except in full screen, where macOS hides
    them; main tells the page on `enter-full-screen` and `leave-full-screen`.
  - **Windows and Linux:** the window controls are overlaid at its right (`titleBarOverlay`), in
    Kiln's chrome colours. Main repaints them when the theme changes, and on OS appearance
    changes for "system". The bar makes room with `env(titlebar-area-*)`.
- **The middle** shows the active tab's title. On a production connection it shows the red
  banner naming the connection instead.
- **The right** holds the window's actions as icons with tooltips: new query, history, compare,
  schedules, jobs (with Kiln's solid rust count badge), and the theme switch (sun or moon). They
  keep their accessible names.
- **Windows and Linux menu bar:** the native menu bar hides with the native title bar there, so
  the title bar draws the application menu at its left (File, Edit, View, Window, Help), as VS
  Code does. It has the same items as the native menu (`shared/window-menu.ts`, checked against
  `main/menu.ts`, which keeps the accelerators working). Each item runs in main through
  `app.menu`, except About, which the page opens.
- **About** lives in the application menu only (macOS app menu, Help elsewhere), as it already
  did; the page's button is gone. Tests that drive only the page open it from the Windows
  and Linux menu bar; on macOS they use the page's `#about` link, since they cannot reach the
  native menu.
- **The app's name:** a development run renames Electron's bundle before starting
  (`scripts/dev-app-name.ts`, macOS only). It sets `CFBundleName` and `CFBundleDisplayName` to
  the product name, so the menu, the Dock and the app switcher say "Joinery" as a packaged build
  does. The dev bundle is ad-hoc signed without a sealed Info.plist, so the change needs no new
  signature.

**Each engine has a pictogram** (`components/EngineIcon.tsx`), drawn in the Kiln Glyphs manner
(16px grid, 1.3 round strokes, a 16% wash). They are simplified outlines, not the projects'
logos, since Kiln redraws no brand marks. Each has one glaze:

| Engine        | Pictogram      | Glaze   |
| ------------- | -------------- | ------- |
| PostgreSQL    | elephant       | cobalt  |
| MySQL         | dolphin        | ochre   |
| MariaDB       | seal           | peach   |
| MongoDB       | leaf           | celadon |
| Redis         | stacked layers | red     |
| Elasticsearch | "e"            | teal    |

They mark each connection in the tree and each tab on a connection. The engine's name is the
tooltip; the icon is hidden from assistive technology, next to the connection's name.

## Consequences

- The window's actions take less room and read as a toolbar, not a menu bar.
- Screenshots of the page (Playwright) do not show the native traffic lights or window controls.
  Their placement is checked by eye.
- The end-to-end launcher can run another build (`JOINERY_E2E_APP_DIR`), so the suites run
  while `pnpm dev` holds `out/`.
