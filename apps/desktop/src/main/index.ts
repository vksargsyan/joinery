import { join } from 'node:path';

import {
  fromElectronPort,
  mainContract,
  serve,
  DEFAULT_APP_SETTINGS,
  type Server,
} from '@joinery/ipc';
import { openStore, type Store } from '@joinery/storage';
import {
  BrowserWindow,
  Menu,
  MessageChannelMain,
  Notification,
  app,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  session,
  shell,
  type MessagePortMain,
  type WebContents,
} from 'electron';

import { HELLO_CHANNEL, PORT_CHANNEL, type PortPayload } from '../shared/bridge';
import { buildContentSecurityPolicy } from '../shared/csp';
import { createMainHandlers, type MainServices, type OpenFileOptions } from './api';
import { APP_ENTRY_URL, APP_ORIGIN, APP_SCHEME, createAppProtocolHandler } from './app-protocol';
import { HostKeyBroker, knownHostsFile } from './host-keys';
import { utilityJobRunnerFactory } from './job-runner-process';
import { JobManager } from './jobs';
import { notificationFor, settingsJobHistory, type SaveFileOptions } from './jobs-api';
import { menuTemplate } from './menu';
import { createSafeStorageSealer } from './sealer';
import {
  hardenSession,
  hardenWebContents,
  isAllowedRequest,
  isAppUrl,
  secureWebPreferences,
} from './security';
import { ConnectionSupervisor } from './supervisor';
import { utilityHostFactory } from './utility-host';

/**
 * Main process (spec §3): app lifecycle, the window, the local store, the main contract for the
 * renderer, and supervision of connection hosts. Drivers never load here.
 */

declare const __JOINERY_DEV_SCRIPT_HASHES__: readonly string[];

// Lets tests and portable setups keep their data elsewhere; must happen before the app is ready.
const userDataDir = process.env['JOINERY_USER_DATA_DIR'];
if (userDataDir) app.setPath('userData', userDataDir);

// Every renderer is sandboxed. The one exception is Chromium's own --no-sandbox switch, which
// turns the OS sandbox off for all processes and aborts at start-up when combined with
// enableSandbox(); only the e2e launcher passes it, in root containers where Chromium refuses to
// sandbox. Windows still set `sandbox: true`, so the preload stays in the sandboxed environment.
if (!app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
  },
]);

const devServerUrl = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL'];
const appOrigin = devServerUrl ? new URL(devServerUrl).origin : APP_ORIGIN;
const openExternal = (url: string): Promise<void> => shell.openExternal(url);

// Chromium's spellchecker downloads Hunspell dictionaries from Google as soon as a session
// starts, and nothing remote is ever loaded (spec §18). Clearing its languages as each session
// is created stops the download; turning it off alone does not.
app.on('session-created', (created) => {
  created.setSpellCheckerEnabled(false);
  created.setSpellCheckerLanguages([]);
});

app.on('web-contents-created', (_event, contents) => {
  hardenWebContents(contents, appOrigin, openExternal);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  void app.whenReady().then(start);
}

let store: Store | undefined;
let supervisor: ConnectionSupervisor<MessagePortMain> | undefined;
let jobs: JobManager | undefined;

function start(): void {
  hardenSession(session.defaultSession);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequest(details.url, appOrigin) });
  });
  if (devServerUrl) {
    const csp = buildContentSecurityPolicy({
      devServerOrigin: devServerUrl,
      scriptHashes: __JOINERY_DEV_SCRIPT_HASHES__,
      header: true,
    });
    session.defaultSession.webRequest.onHeadersReceived(
      { urls: [`${appOrigin}/*`] },
      (details, callback) => {
        callback({
          responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] },
        });
      },
    );
  } else {
    protocol.handle(
      APP_SCHEME,
      createAppProtocolHandler(
        join(__dirname, '../renderer'),
        buildContentSecurityPolicy({ header: true }),
      ),
    );
  }

  let openedStore: Store;
  try {
    openedStore = openStore(join(app.getPath('userData'), 'joinery.db'), {
      sealer: createSafeStorageSealer(safeStorage),
    });
  } catch (error) {
    dialog.showErrorBox(
      'Joinery cannot open its data',
      `The local store in ${app.getPath('userData')} could not be opened: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    app.exit(1);
    return;
  }
  store = openedStore;
  const spawnHost = utilityHostFactory(join(__dirname, 'connection-host.cjs'));
  // SSH host keys the user trusted and remembered; joinery-cli reads the same file by default.
  const hostKeys = new HostKeyBroker({
    store: knownHostsFile(join(app.getPath('userData'), 'known_hosts')),
  });
  const connections = new ConnectionSupervisor<MessagePortMain>({ spawn: spawnHost, hostKeys });
  supervisor = connections;
  const services: MainServices<MessagePortMain> = {
    store: openedStore,
    supervisor: connections,
    spawnHost,
    createChannel: () => {
      const { port1, port2 } = new MessageChannelMain();
      return { local: port1, remote: port2 };
    },
    appInfo: () => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      versions: {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      },
    }),
    openExternal,
    hostKeys,
    keysDir: join(app.getPath('userData'), 'ssh-keys'),
    jobs: startJobs(openedStore, hostKeys),
    // The desktop starts dark and without the editor minimap; users change both in settings.
    defaultSettings: {
      ...DEFAULT_APP_SETTINGS,
      theme: 'dark',
      editor: { ...DEFAULT_APP_SETTINGS.editor, minimap: false },
    },
  };
  serveMainContract(services);

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate({
        platform: process.platform,
        appName: app.getName(),
        development: !app.isPackaged,
      }),
    ),
  );
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

/**
 * The page asks for the main contract with a hello on HELLO_CHANNEL (each load does). Main
 * answers only its own window's main frame on the app origin, serving the contract on a fresh
 * MessageChannel and transferring the other end (ADR 0004).
 */
function serveMainContract(services: MainServices<MessagePortMain>): void {
  const servers = new Map<WebContents, { server: Server; port: MessagePortMain }>();
  const stop = (contents: WebContents): void => {
    const current = servers.get(contents);
    if (!current) return;
    servers.delete(contents);
    current.server.dispose();
    current.port.close();
  };
  ipcMain.on(HELLO_CHANNEL, (event) => {
    const contents = event.sender;
    const frame = event.senderFrame;
    if (!frame || frame !== contents.mainFrame || !isAppUrl(frame.url, appOrigin)) return;
    const owner = BrowserWindow.fromWebContents(contents);
    if (!owner) return;
    if (!servers.has(contents)) contents.once('destroyed', () => stop(contents));
    stop(contents);
    const { port1, port2 } = new MessageChannelMain();
    const sendPort = (payload: PortPayload, port: MessagePortMain): void => {
      if (!contents.isDestroyed()) contents.postMessage(PORT_CHANNEL, payload, [port]);
    };
    const openFile = async (options: OpenFileOptions): Promise<string | null> => {
      const result = await dialog.showOpenDialog(owner, {
        ...(options.title === undefined ? {} : { title: options.title }),
        // SSH keys live in ~/.ssh, a hidden folder.
        properties: ['openFile', 'showHiddenFiles'],
        filters: (options.filters ?? []).map((f) => ({
          name: f.name,
          extensions: [...f.extensions],
        })),
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    };
    const saveFile = async (options: SaveFileOptions): Promise<string | null> => {
      const result = await dialog.showSaveDialog(owner, {
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.defaultName === undefined ? {} : { defaultPath: options.defaultName }),
        filters: (options.filters ?? []).map((f) => ({
          name: f.name,
          extensions: [...f.extensions],
        })),
      });
      return result.canceled ? null : (result.filePath ?? null);
    };
    const openDirectory = async (options: { title?: string | undefined }) => {
      const result = await dialog.showOpenDialog(owner, {
        ...(options.title === undefined ? {} : { title: options.title }),
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    };
    const server = serve(
      fromElectronPort(port1),
      mainContract,
      createMainHandlers(services, { sendPort, openFile, saveFile, openDirectory }),
    );
    servers.set(contents, { server, port: port1 });
    sendPort({ kind: 'main' }, port2);
  });
}

/**
 * The job runner (spec §3): started on demand, its history kept in the local store, and a
 * desktop notification when a long job ends (spec §14).
 */
function startJobs(openedStore: Store, hostKeys: HostKeyBroker): JobManager {
  jobs = new JobManager({
    spawn: utilityJobRunnerFactory(join(__dirname, 'job-runner.cjs')),
    history: settingsJobHistory(openedStore),
    hostKeys,
    notify: (job) => {
      if (!Notification.isSupported()) return;
      new Notification(notificationFor(job)).show();
    },
  });
  return jobs;
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Joinery',
    backgroundColor: '#101216',
    webPreferences: secureWebPreferences(join(__dirname, '../preload/index.cjs'), !app.isPackaged),
  });
  window.once('ready-to-show', () => window.show());
  void window.loadURL(devServerUrl ?? APP_ENTRY_URL);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  supervisor?.closeAll();
  jobs?.shutdown();
  jobs = undefined;
  supervisor = undefined;
});

app.on('will-quit', () => {
  store?.close();
  store = undefined;
});
