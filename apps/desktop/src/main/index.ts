import { join } from 'node:path';

import {
  fromElectronPort,
  mainContract,
  serve,
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type Server,
  type WindowMenuCommand,
} from '@querybara/ipc';
import { openStore, type ScheduleRecord, type ScheduleRun, type Store } from '@querybara/storage';
import {
  BrowserWindow,
  Menu,
  MessageChannelMain,
  Notification,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  protocol,
  safeStorage,
  session,
  shell,
  type MessagePortMain,
  type WebContents,
} from 'electron';

import windowIcon from '../../build/icons/512x512.png?asset';
import { HELLO_CHANNEL, PORT_CHANNEL, type PortPayload } from '../shared/bridge';
import { buildContentSecurityPolicy } from '../shared/csp';
import {
  createMainHandlers,
  readAppSettings,
  writeAppSettings,
  type MainServices,
  type OpenFileOptions,
} from './api';
import { APP_ENTRY_URL, APP_ORIGIN, APP_SCHEME, createAppProtocolHandler } from './app-protocol';
import { HostKeyBroker, knownHostsFile } from './host-keys';
import { utilityJobRunnerFactory } from './job-runner-process';
import { JobManager } from './jobs';
import { notificationFor, settingsJobHistory, type SaveFileOptions } from './jobs-api';
import { executeSchedule } from './schedule-tasks';
import { Scheduler, type TaskOutcome } from './scheduler';
import { ScheduleEvents } from './schedules-api';
import { menuTemplate } from './menu';
import { effectiveTheme, titleBarOverlay, windowChrome } from './window-chrome';
import { QuitGuard } from './quit-guard';
import { createSafeStorageSealer } from './sealer';
import {
  hardenSession,
  hardenWebContents,
  isAllowedRequest,
  isAppUrl,
  secureWebPreferences,
} from './security';
import { ConnectionSupervisor } from './supervisor';
import { SyncService } from './sync';
import { isAllowedUpdateUrl, RELEASES_PAGE } from './update-policy';
import { AppCommands, createUpdates, type UpdateController, type UpdateSettings } from './updates';
import { utilityHostFactory } from './utility-host';

/**
 * Main process (spec §3): app lifecycle, the window, the local store, the main contract for the
 * renderer, and supervision of connection hosts. Drivers never load here.
 */

declare const __QUERYBARA_DEV_SCRIPT_HASHES__: readonly string[];

// Lets tests and portable setups keep their data elsewhere; must happen before the app is ready.
const userDataDir = process.env['QUERYBARA_USER_DATA_DIR'];
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
    } else if (app.isReady()) {
      // Running without a window (macOS): opening Querybara again opens one.
      createMainWindow();
    }
  });
  void app.whenReady().then(start);
}

let store: Store | undefined;
let supervisor: ConnectionSupervisor<MessagePortMain> | undefined;
let jobs: JobManager | undefined;
let sync: SyncService | undefined;
let updates: UpdateController | undefined;
let scheduler: Scheduler | undefined;
let quitGuard: QuitGuard<BrowserWindow> | undefined;
/** The theme setting the window chrome follows, and where full-screen changes are sent. */
let themeSetting: AppSettings['theme'] = 'dark';
let windowCommands: AppCommands | undefined;

function start(): void {
  hardenSession(session.defaultSession);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRequest(details.url, appOrigin) });
  });
  if (devServerUrl) {
    const csp = buildContentSecurityPolicy({
      devServerOrigin: devServerUrl,
      scriptHashes: __QUERYBARA_DEV_SCRIPT_HASHES__,
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
    openedStore = openStore(join(app.getPath('userData'), 'querybara.db'), {
      sealer: createSafeStorageSealer(safeStorage),
    });
  } catch (error) {
    dialog.showErrorBox(
      'Querybara cannot open its data',
      `The local store in ${app.getPath('userData')} could not be opened: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    app.exit(1);
    return;
  }
  store = openedStore;
  // Read before this run marks itself as running: editor restore says whether the last one crashed.
  const previousRun = openedStore.autosave.startRun().ended;
  const spawnHost = utilityHostFactory(join(__dirname, 'connection-host.cjs'));
  // SSH host keys the user trusted and remembered; querybara-cli reads the same file by default.
  const hostKeys = new HostKeyBroker({
    store: knownHostsFile(join(app.getPath('userData'), 'known_hosts')),
  });
  const connections = new ConnectionSupervisor<MessagePortMain>({ spawn: spawnHost, hostKeys });
  supervisor = connections;
  const jobManager = startJobs(openedStore, hostKeys);
  // Data compare jobs spool their rows under the temporary folder, for this app run only.
  sync = new SyncService({ jobs: jobManager, spoolRoot: app.getPath('temp') });
  const scheduleEvents = new ScheduleEvents();
  const syncService = sync;
  scheduler = new Scheduler({
    store: openedStore.schedules,
    execute: (schedule) =>
      executeSchedule({ store: openedStore, jobs: jobManager, sync: syncService }, schedule),
    notify: notifySchedule,
    onEvent: (event) => scheduleEvents.publish(event),
  });
  // The desktop starts dark and without the editor minimap; users change both in settings.
  const defaultSettings = {
    ...DEFAULT_APP_SETTINGS,
    theme: 'dark' as const,
    editor: { ...DEFAULT_APP_SETTINGS.editor, minimap: false },
  };
  const appCommands = new AppCommands();
  windowCommands = appCommands;
  themeSetting = readAppSettings(openedStore, defaultSettings).theme;
  const activeScheduler = scheduler;
  quitGuard = new QuitGuard<BrowserWindow>({
    platform: process.platform,
    enabled: () => readAppSettings(openedStore, defaultSettings).schedules.confirmClose,
    paused: () => activeScheduler.paused,
    schedules: () =>
      openedStore.schedules.list().map((schedule) => ({
        name: schedule.name,
        enabled: schedule.enabled,
        nextRunAt: schedule.nextRunAt,
        running: activeScheduler.isRunning(schedule.id),
      })),
    ask: async (question, window) => {
      const options = {
        type: 'question' as const,
        message: question.message,
        detail: question.detail,
        buttons: [...question.buttons],
        defaultId: 0,
        cancelId: 1,
        checkboxLabel: question.checkboxLabel,
        noLink: true,
      };
      const answer =
        window && !window.isDestroyed()
          ? await dialog.showMessageBox(window, options)
          : await dialog.showMessageBox(options);
      return { confirmed: answer.response === 0, dontAskAgain: answer.checkboxChecked };
    },
    stopAsking: () => {
      writeAppSettings(openedStore, defaultSettings, { schedules: { confirmClose: false } });
    },
    quit: () => app.quit(),
  });
  // Nothing may hold up a shutdown or a logout.
  powerMonitor.on('shutdown', () => quitGuard?.bypass());
  const updater = startUpdates(readAppSettings(openedStore, defaultSettings));
  const menuCommands = {
    checkForUpdates: () => void updater.check(),
    releaseNotes: () => {
      openExternal(updater.status().releaseNotesUrl ?? RELEASES_PAGE).catch(() => undefined);
    },
  };
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
    jobs: jobManager,
    sync,
    scheduler,
    scheduleEvents,
    previousRun,
    defaultSettings,
    updates: updater,
    appCommands,
    menuCommands,
    development: !app.isPackaged,
    onSettingsChanged: (settings) => {
      updater.applySettings(settings);
      themeSetting = settings.theme;
      for (const window of BrowserWindow.getAllWindows()) applyChrome(window);
    },
  };
  serveMainContract(services);

  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate({
        platform: process.platform,
        appName: app.getName(),
        development: !app.isPackaged,
        commands: {
          about: () => appCommands.send('about'),
          commandPalette: () => appCommands.send('command-palette'),
          quickOpen: () => appCommands.send('quick-open'),
          keyboardShortcuts: () => appCommands.send('keyboard-shortcuts'),
          ...menuCommands,
        },
      }),
    ),
  );
  if (!app.isPackaged) app.dock?.setIcon(windowIcon);
  createMainWindow();
  void updater.start();
  // Schedules run while Querybara is open; a sleep or a clock change is checked at once.
  scheduler.start();
  powerMonitor.on('resume', () => scheduler?.wake());
  powerMonitor.on('unlock-screen', () => scheduler?.wake());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  // "System" follows the OS appearance, in the window controls too.
  nativeTheme.on('updated', () => {
    for (const window of BrowserWindow.getAllWindows()) applyChrome(window);
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
    const runMenu = (command: WindowMenuCommand): void => {
      switch (command) {
        case 'undo':
        case 'redo':
        case 'cut':
        case 'copy':
        case 'paste':
        case 'selectAll':
        case 'reload':
          contents[command]();
          break;
        case 'toggleDevTools':
          contents.toggleDevTools();
          break;
        case 'resetZoom':
          contents.setZoomLevel(0);
          break;
        case 'zoomIn':
        case 'zoomOut':
          contents.setZoomLevel(contents.getZoomLevel() + (command === 'zoomIn' ? 0.5 : -0.5));
          break;
        case 'toggleFullScreen':
          owner.setFullScreen(!owner.isFullScreen());
          break;
        case 'minimize':
          owner.minimize();
          break;
        case 'close':
          owner.close();
          break;
        case 'quit':
          app.quit();
          break;
        default:
          break;
      }
    };
    const server = serve(
      fromElectronPort(port1),
      mainContract,
      createMainHandlers(services, { sendPort, openFile, saveFile, openDirectory, runMenu }),
    );
    servers.set(contents, { server, port: port1 });
    sendPort({ kind: 'main' }, port2);
  });
}

/**
 * Auto-update (spec §20): electron-updater in its own session, which may reach GitHub only.
 */
function startUpdates(settings: UpdateSettings): UpdateController {
  // electron-updater downloads through this partition (its NET_SESSION_NAME).
  session
    .fromPartition('electron-updater', { cache: false })
    .webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isAllowedUpdateUrl(details.url) });
    });
  updates = createUpdates({
    host: {
      packaged: app.isPackaged,
      version: app.getVersion(),
      platform: process.platform,
      env: process.env,
      execPath: process.execPath,
      resourcesPath: process.resourcesPath,
    },
    settings,
    log: (message) => console.info(`[updates] ${message}`),
    // Restarting into the update is the user's own choice: it does not ask again.
    beforeInstall: () => quitGuard?.bypass(),
  });
  return updates;
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

/** The chrome's colours for the current theme (the Windows and Linux controls overlay). */
function applyChrome(window: BrowserWindow): void {
  const theme = effectiveTheme(themeSetting, nativeTheme.shouldUseDarkColors);
  const chrome = windowChrome(process.platform, theme);
  window.setBackgroundColor(chrome.backgroundColor!);
  if (process.platform !== 'darwin') window.setTitleBarOverlay(titleBarOverlay(theme));
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Querybara',
    ...windowChrome(
      process.platform,
      effectiveTheme(themeSetting, nativeTheme.shouldUseDarkColors),
    ),
    // Windows and macOS take the icon from the executable and the bundle; Linux needs it here.
    ...(process.platform === 'linux' || !app.isPackaged ? { icon: windowIcon } : {}),
    webPreferences: secureWebPreferences(join(__dirname, '../preload/index.cjs'), !app.isPackaged),
  });
  window.once('ready-to-show', () => window.show());
  // The title bar leaves room for the traffic lights, which macOS hides in full screen.
  window.on('enter-full-screen', () => windowCommands?.send('enter-full-screen'));
  window.on('leave-full-screen', () => windowCommands?.send('leave-full-screen'));
  // Windows and Linux quit with their last window: with schedules on, ask first.
  window.on('close', (event) => {
    const last = BrowserWindow.getAllWindows().every((other) => other === window);
    if (last && quitGuard && !quitGuard.lastWindowClosing(window)) event.preventDefault();
  });
  // Windows: the session is ending (shut down, restart, sign out); never hold it up.
  window.on('query-session-end', () => quitGuard?.bypass());
  window.on('session-end', () => quitGuard?.bypass());
  void window.loadURL(devServerUrl ?? APP_ENTRY_URL);
}

/** A scheduled run's desktop notification, as its schedule says (failures by default). */
function notifySchedule(schedule: ScheduleRecord, run: ScheduleRun, outcome: TaskOutcome): void {
  if (!Notification.isSupported() || schedule.notify === 'never') return;
  const failed = run.status === 'failed';
  if (schedule.notify === 'failures' && !failed && !outcome.attention) return;
  const notification = new Notification({
    title: failed
      ? `Scheduled run failed: ${schedule.name}`
      : outcome.attention
        ? `${schedule.name}: worth a look`
        : `${schedule.name} finished`,
    body: run.message ?? (failed ? 'The run failed' : 'Done'),
  });
  notification.on('click', () => showMainWindow());
  notification.show();
}

function showMainWindow(): void {
  const [window] = BrowserWindow.getAllWindows();
  if (!window) {
    createMainWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.focus();
}

app.on('window-all-closed', () => {
  // macOS apps keep running without windows; elsewhere the last window closing quits.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  // With schedules on, the question comes first; confirming quits again.
  const [window] = BrowserWindow.getAllWindows();
  if (quitGuard && !quitGuard.beforeQuit(BrowserWindow.getFocusedWindow() ?? window)) {
    event.preventDefault();
    return;
  }
  scheduler?.stop();
  scheduler = undefined;
  updates?.dispose();
  supervisor?.closeAll();
  jobs?.shutdown();
  jobs = undefined;
  supervisor = undefined;
});

app.on('will-quit', () => {
  // The job runner has stopped writing by now; data compare spools go with the app run.
  sync?.dispose();
  sync = undefined;
});

app.on('will-quit', () => {
  store?.autosave.finishRun();
  store?.close();
  store = undefined;
});
