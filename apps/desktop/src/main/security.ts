import type { WebPreferences } from 'electron';

/**
 * Electron hardening for every window and web contents (spec §18). Kept free of runtime Electron
 * imports so each rule is unit-tested; `installSecurityHandlers` wires them to the real objects.
 */

/**
 * The renderer runs as a plain sandboxed web page: no Node.js, isolated world for the preload,
 * web security on, no `<webview>`. `devTools` is the only switch, off in packaged builds.
 */
export function secureWebPreferences(preload: string, devTools: boolean): WebPreferences {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    spellcheck: false,
    devTools,
  };
}

/**
 * True when `url` is part of the app itself (same origin as the app entry), which only happens
 * for a reload. Everything else is blocked: the app never navigates.
 */
export function isAppUrl(url: string, appOrigin: string): boolean {
  try {
    // Compared by parts: Node's URL reports the origin of a custom scheme such as app:// as
    // "null", although Chromium treats the registered standard scheme as a real origin.
    const target = new URL(url);
    const app = new URL(appOrigin);
    return (
      target.protocol === app.protocol &&
      target.hostname === app.hostname &&
      target.port === app.port &&
      target.username === '' &&
      target.password === ''
    );
  } catch {
    return false;
  }
}

/**
 * Requests the app's session may make (spec §18: no remote content is ever loaded): its own
 * files (the app protocol, or the dev server in development, with its hot-reload socket) and
 * data, blob and devtools URLs. Anything else is cancelled before it leaves the machine.
 */
export function isAllowedRequest(url: string, appOrigin: string): boolean {
  if (isAppUrl(url, appOrigin)) return true;
  const app = new URL(appOrigin);
  if (app.protocol === 'http:' && isAppUrl(url.replace(/^ws:/, 'http:'), appOrigin)) return true;
  return /^(data|blob|devtools):/.test(url);
}

/**
 * External links may open in the system browser only when they are plain https URLs to a named
 * host, without embedded credentials (spec §18: "after a check").
 */
export function isSafeExternalUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (
    parsed.protocol === 'https:' &&
    parsed.hostname !== '' &&
    parsed.username === '' &&
    parsed.password === '' &&
    url.length <= 2048
  );
}

export interface PreventableEvent {
  preventDefault(): void;
}

/** Opens a checked URL in the system browser; `shell.openExternal` in the app. */
export type OpenExternal = (url: string) => Promise<void>;

/** Opens `url` externally if it passes the check. Returns whether it was opened. */
export async function openExternalIfSafe(url: string, open: OpenExternal): Promise<boolean> {
  if (!isSafeExternalUrl(url)) return false;
  await open(url);
  return true;
}

/**
 * `will-navigate` / `will-redirect`: blocks leaving the app. A safe https link is handed to the
 * system browser instead.
 */
export function guardNavigation(
  event: PreventableEvent,
  url: string,
  appOrigin: string,
  open: OpenExternal,
): void {
  if (isAppUrl(url, appOrigin)) return;
  event.preventDefault();
  void openExternalIfSafe(url, open).catch(() => undefined);
}

/** `setWindowOpenHandler`: never opens a window; a safe https link goes to the system browser. */
export function denyWindowOpen(url: string, open: OpenExternal): { action: 'deny' } {
  void openExternalIfSafe(url, open).catch(() => undefined);
  return { action: 'deny' };
}

/** Every permission request (camera, notifications, clipboard-read...) is refused. */
export function denyPermissionRequest(
  _webContents: unknown,
  _permission: string,
  callback: (granted: boolean) => void,
): void {
  callback(false);
}

/** Every permission check is answered "no". */
export function denyPermissionCheck(): boolean {
  return false;
}

/** The structural slice of Electron's web contents the handlers attach to. */
export interface WebContentsLike {
  on(event: 'will-navigate', listener: (event: PreventableEvent, url: string) => void): unknown;
  on(event: 'will-redirect', listener: (event: PreventableEvent, url: string) => void): unknown;
  on(event: 'will-attach-webview', listener: (event: PreventableEvent) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void;
}

export interface SessionLike {
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler(handler: () => boolean): void;
}

/** Applies the navigation, window-open and webview rules to one web contents. */
export function hardenWebContents(
  contents: WebContentsLike,
  appOrigin: string,
  open: OpenExternal,
): void {
  contents.on('will-navigate', (event, url) => guardNavigation(event, url, appOrigin, open));
  contents.on('will-redirect', (event, url) => guardNavigation(event, url, appOrigin, open));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => denyWindowOpen(url, open));
}

/** Denies every permission request and check on a session. */
export function hardenSession(session: SessionLike): void {
  session.setPermissionRequestHandler(denyPermissionRequest);
  session.setPermissionCheckHandler(denyPermissionCheck);
}
