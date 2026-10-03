import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { menuTemplate } from '../src/main/menu';
import {
  denyPermissionCheck,
  denyPermissionRequest,
  denyWindowOpen,
  guardNavigation,
  hardenSession,
  hardenWebContents,
  isAllowedRequest,
  isAppUrl,
  isSafeExternalUrl,
  openExternalIfSafe,
  secureWebPreferences,
  type PreventableEvent,
  type WebContentsLike,
} from '../src/main/security';

const APP = 'app://querybara';

function event(): PreventableEvent & { prevented: boolean } {
  const e = {
    prevented: false,
    preventDefault() {
      e.prevented = true;
    },
  };
  return e;
}

describe('window hardening (spec §18)', () => {
  it('runs the renderer isolated, sandboxed and without Node.js', () => {
    const prefs = secureWebPreferences('/app/out/preload/index.cjs', false);
    expect(prefs).toMatchObject({
      preload: '/app/out/preload/index.cjs',
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
      devTools: false,
    });
    expect(prefs).not.toHaveProperty('enableBlinkFeatures');
    expect(secureWebPreferences('/p', true).devTools).toBe(true);
  });
});

describe('navigation and new windows', () => {
  it('recognises only the app origin, including custom-scheme origins', () => {
    expect(isAppUrl('app://querybara/index.html', APP)).toBe(true);
    expect(isAppUrl('app://querybara/assets/x.js?v=1#top', APP)).toBe(true);
    expect(isAppUrl('app://evil/index.html', APP)).toBe(false);
    expect(isAppUrl('https://querybara/index.html', APP)).toBe(false);
    expect(isAppUrl('app://user:pass@querybara/', APP)).toBe(false);
    expect(isAppUrl('not a url', APP)).toBe(false);
    expect(isAppUrl('http://localhost:5173/src/main.tsx', 'http://localhost:5173')).toBe(true);
    expect(isAppUrl('http://localhost:5174/', 'http://localhost:5173')).toBe(false);
  });

  it('blocks navigation away from the app and hands safe links to the browser', async () => {
    const open = vi.fn(async () => {});
    const inApp = event();
    guardNavigation(inApp, 'app://querybara/index.html', APP, open);
    expect(inApp.prevented).toBe(false);

    for (const url of [
      'https://example.com/',
      'http://example.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'app://other/',
    ]) {
      const e = event();
      guardNavigation(e, url, APP, open);
      expect(e.prevented, url).toBe(true);
    }
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledWith('https://example.com/');
  });

  it('never opens a window', async () => {
    const open = vi.fn(async () => {});
    expect(denyWindowOpen('https://docs.querybara.dev/', open)).toEqual({ action: 'deny' });
    expect(denyWindowOpen('file:///etc/passwd', open)).toEqual({ action: 'deny' });
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(open).toHaveBeenCalledWith('https://docs.querybara.dev/');
  });

  it('opens only plain https links externally', async () => {
    expect(isSafeExternalUrl('https://querybara.dev/docs?a=1')).toBe(true);
    for (const url of [
      'http://querybara.dev',
      'https://user:pw@querybara.dev',
      'file:///C:/Windows/system32/calc.exe',
      'smb://server/share',
      'javascript:alert(1)',
      'https:',
      `https://querybara.dev/${'a'.repeat(3000)}`,
    ]) {
      expect(isSafeExternalUrl(url), url).toBe(false);
    }
    const open = vi.fn(async () => {});
    expect(await openExternalIfSafe('ms-settings:privacy', open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it('wires the handlers onto web contents', () => {
    const emitter = new EventEmitter();
    let windowOpen: ((details: { url: string }) => { action: 'deny' }) | undefined;
    const contents = Object.assign(emitter, {
      setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }) {
        windowOpen = handler;
      },
    }) as unknown as WebContentsLike & EventEmitter;
    const open = vi.fn(async () => {});
    hardenWebContents(contents, APP, open);

    const navigate = event();
    contents.emit('will-navigate', navigate, 'https://evil.example/');
    expect(navigate.prevented).toBe(true);
    const redirect = event();
    contents.emit('will-redirect', redirect, 'http://evil.example/');
    expect(redirect.prevented).toBe(true);
    const webview = event();
    contents.emit('will-attach-webview', webview);
    expect(webview.prevented).toBe(true);
    expect(windowOpen?.({ url: 'app://querybara/index.html' })).toEqual({ action: 'deny' });
  });
});

describe('permissions and requests', () => {
  it('denies every permission request and check', () => {
    const callback = vi.fn();
    denyPermissionRequest({}, 'media', callback);
    denyPermissionRequest({}, 'clipboard-read', callback);
    expect(callback.mock.calls).toEqual([[false], [false]]);
    expect(denyPermissionCheck()).toBe(false);

    const session = { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() };
    hardenSession(session);
    expect(session.setPermissionRequestHandler).toHaveBeenCalledWith(denyPermissionRequest);
    expect(session.setPermissionCheckHandler).toHaveBeenCalledWith(denyPermissionCheck);
  });

  it('lets only local requests leave the renderer session', () => {
    expect(isAllowedRequest('app://querybara/assets/index.js', APP)).toBe(true);
    expect(isAllowedRequest('data:image/png;base64,AAAA', APP)).toBe(true);
    expect(isAllowedRequest('blob:app://querybara/1234', APP)).toBe(true);
    expect(isAllowedRequest('https://redirector.gvt1.com/edgedl/chrome/dict/en-us.bdic', APP)).toBe(
      false,
    );
    expect(isAllowedRequest('https://cdn.jsdelivr.net/npm/monaco-editor/min/loader.js', APP)).toBe(
      false,
    );
    expect(isAllowedRequest('ws://localhost:5173/', APP)).toBe(false);
    const dev = 'http://localhost:5173';
    expect(isAllowedRequest('http://localhost:5173/@vite/client', dev)).toBe(true);
    expect(isAllowedRequest('ws://localhost:5173/?token=x', dev)).toBe(true);
    expect(isAllowedRequest('ws://localhost:9999/', dev)).toBe(false);
  });
});

describe('application menu', () => {
  const labels = (options: Parameters<typeof menuTemplate>[0]): string[] =>
    menuTemplate(options).flatMap((menu) =>
      Array.isArray(menu.submenu) ? menu.submenu.map((item) => String(item.role ?? item.type)) : [],
    );

  it('offers reload and developer tools only in development', () => {
    expect(labels({ platform: 'linux', appName: 'Querybara', development: false })).not.toContain(
      'toggleDevTools',
    );
    expect(labels({ platform: 'linux', appName: 'Querybara', development: true })).toContain(
      'toggleDevTools',
    );
    expect(labels({ platform: 'darwin', appName: 'Querybara', development: false })).toContain(
      'paste',
    );
  });
});
