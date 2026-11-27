import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, session, shell, type MenuItemConstructorOptions } from 'electron';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getLastVersion, getServerUrl, getWindowState, normaliseServerUrl, saveWindowState, setLastVersion, setServerUrl, takeResume } from './config';
import { mayUse } from './permissions';
import { startUpdater } from './updater';

/**
 * The desktop app is a native window around the OS_Planner website. It adds only what a browser tab cannot
 * do (a real window, menus, a native "Save as" dialog, updates from the site). Every feature of the
 * app itself lives on the website and works the same in a browser.
 */

const PARTITION = 'persist:os_planner'; // cookies, IndexedDB and the service worker survive restarts
const RESOURCES = join(__dirname, '..', 'resources');

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
/** The website's report of a call, an open dialog or unsaved work: a silent update waits while this is true. */
let webBusy = false;
/** The version this install ran before an update, handed to the page once so it can say "updated". */
let updatedFrom: string | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  void app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createMainWindow());
}

const origin = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};
const serverOrigin = () => origin(getServerUrl());
const isHttp = (url: string) => /^https?:\/\//i.test(url);

function start(): void {
  const previous = getLastVersion();
  if (previous !== app.getVersion()) {
    if (previous) updatedFrom = previous;
    setLastVersion(app.getVersion());
  }
  hardenSession();
  registerIpc();
  Menu.setApplicationMenu(buildMenu());
  createMainWindow();
  startUpdater({ window: () => mainWindow, webBusy: () => webBusy });
}

/**
 * The page may use the clipboard and fullscreen, and (only the OS_Planner site itself, for voice and video channels) the microphone,
 * the camera and the screen; location and the rest stay off. See permissions.ts. Sharing the screen asks the person which screen or
 * window, every time (a small menu), and nothing is captured without that choice.
 */
function hardenSession(): void {
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => callback(mayUse(permission, details.requestingUrl, serverOrigin())));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => mayUse(permission, requestingOrigin, serverOrigin()));
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!mayUse('display-capture', request.frame?.url, serverOrigin())) return callback({});
    void chooseScreen(callback);
  }, { useSystemPicker: false });
}

/** A menu of the screens and windows that can be shared; closing it without a choice refuses. */
async function chooseScreen(callback: (streams: { video?: Electron.DesktopCapturerSource; audio?: 'loopback' }) => void): Promise<void> {
  let answered = false;
  const answer = (streams: Parameters<typeof callback>[0]) => {
    if (answered) return;
    answered = true;
    callback(streams);
  };
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    if (!sources.length || !mainWindow) return answer({});
    const menu = Menu.buildFromTemplate([
      { label: 'Share…', enabled: false },
      { type: 'separator' },
      ...sources.map((source): MenuItemConstructorOptions => ({
        label: source.name || source.id,
        // the sound of the whole screen is shared with a screen, not with a single window
        click: () => answer({ video: source, ...(source.id.startsWith('screen:') ? { audio: 'loopback' as const } : {}) }),
      })),
    ]);
    menu.popup({ window: mainWindow, callback: () => setTimeout(() => answer({}), 0) });
  } catch {
    answer({});
  }
}

function createMainWindow(): void {
  const state = getWindowState();
  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 420,
    minHeight: 520,
    show: false,
    backgroundColor: '#f8f9fc',
    title: 'OS_Planner',
    icon: join(RESOURCES, 'icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  mainWindow = win;
  if (state.maximized) win.maximize();
  // After a silent update the app comes back on the same page, and stays out of the way if it was minimised.
  const resume = takeResume(serverOrigin());
  win.once('ready-to-show', () => {
    if (resume?.minimized) {
      win.showInactive();
      win.minimize();
    } else win.show();
  });

  const remember = () => {
    if (win.isDestroyed()) return;
    const b = win.getNormalBounds();
    saveWindowState({ ...b, maximized: win.isMaximized() });
  };
  win.on('close', remember);
  win.on('resized', remember);
  win.on('moved', remember);
  win.on('closed', () => (mainWindow = null));

  // Links to other sites open in the real browser; the window never leaves the OS_Planner site.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('file:')) return; // our own offline page
    if (origin(url) !== serverOrigin()) {
      event.preventDefault();
      if (isHttp(url)) void shell.openExternal(url);
    }
  });

  // A page that is going away can no longer say it is busy; the next one reports for itself.
  win.webContents.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) webBusy = false;
  });

  // No connection and nothing cached yet: show a friendly page with a retry button instead of a blank window.
  win.webContents.on('did-fail-load', (_e, code, _description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted: a redirect or a newer navigation */) return;
    if (url.startsWith('file:')) return;
    const query = new URLSearchParams({ server: getServerUrl() }).toString();
    void win.loadFile(join(RESOURCES, 'offline.html'), { search: query });
  });

  void win.loadURL(resume?.url ?? getServerUrl());
}

function buildMenu(): Menu {
  const send = (command: string) => mainWindow?.webContents.send('menu-command', command);
  const mac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'New page', accelerator: 'CmdOrCtrl+N', click: () => send('new-page') },
        { label: 'Search…', accelerator: 'CmdOrCtrl+K', click: () => send('search') },
        { type: 'separator' },
        { label: 'Change server…', click: openSettings },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Open the website in your browser', click: () => void shell.openExternal(getServerUrl()) },
        { label: 'Download page', click: () => void shell.openExternal(`${getServerUrl()}/download`) },
        { type: 'separator' },
        { label: `OS_Planner desktop ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

/** A small window for changing which server the app shows (for self-hosted installs). */
function openSettings(): void {
  if (settingsWindow) return void settingsWindow.focus();
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 260,
    parent: mainWindow ?? undefined,
    modal: !!mainWindow,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'Server',
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  settingsWindow.removeMenu();
  settingsWindow.on('closed', () => (settingsWindow = null));
  void settingsWindow.loadFile(join(RESOURCES, 'server.html'));
}

function registerIpc(): void {
  // Native "Save as": only the OS_Planner site itself may ask for it.
  ipcMain.handle('save-file', async (event, data: ArrayBuffer, suggestedName: string) => {
    if (origin(event.senderFrame?.url ?? '') !== serverOrigin()) throw new Error('not allowed');
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const name = basename(String(suggestedName)).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_') || 'os-planner';
    const { canceled, filePath } = await dialog.showSaveDialog(win!, { defaultPath: name });
    if (canceled || !filePath) return false;
    await writeFile(filePath, Buffer.from(data));
    return true;
  });

  // The website tells the shell when a restart would cost the person something (a call, a dialog, unsaved work).
  ipcMain.on('app:busy', (event, busy: unknown) => {
    if (origin(event.senderFrame?.url ?? '') !== serverOrigin()) return;
    webBusy = busy === true;
  });
  // Read by the preload script at start-up: the real version (a packaged app has no npm_package_version) and, once, what it was updated from.
  ipcMain.on('desktop:info', (event) => {
    const info = { version: app.getVersion(), updatedFrom };
    if (origin(event.senderFrame?.url ?? '') === serverOrigin()) updatedFrom = null; // our own local pages must not use it up
    event.returnValue = info;
  });

  // Settings and the offline page are our own local files; nothing from the web may read or change the server address.
  const fromLocalPage = (url: string | undefined) => !!url && url.startsWith('file:');
  ipcMain.handle('config:get', (event) => {
    if (!fromLocalPage(event.senderFrame?.url)) throw new Error('not allowed');
    return getServerUrl();
  });
  ipcMain.handle('config:set', (event, value: string) => {
    if (!fromLocalPage(event.senderFrame?.url)) throw new Error('not allowed');
    const saved = setServerUrl(String(value));
    if (!saved) return { ok: false as const };
    settingsWindow?.close();
    void mainWindow?.loadURL(saved);
    return { ok: true as const, url: saved };
  });
  ipcMain.handle('config:validate', (_event, value: string) => normaliseServerUrl(String(value)) !== null);
  ipcMain.handle('config:open', (event) => {
    if (!fromLocalPage(event.senderFrame?.url)) throw new Error('not allowed');
    openSettings();
  });
}

