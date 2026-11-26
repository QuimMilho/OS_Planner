import { app, BrowserWindow, dialog, ipcMain, Menu, net, session, shell, type MenuItemConstructorOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getServerUrl, getWindowState, normaliseServerUrl, saveWindowState, setServerUrl } from './config';

/**
 * The desktop app is a native window around the OS_Planner website. It adds only what a browser tab cannot
 * do (a real window, menus, a native "Save as" dialog, updates from the site). Every feature of the
 * app itself lives on the website and works the same in a browser.
 */

const PARTITION = 'persist:os_planner'; // cookies, IndexedDB and the service worker survive restarts
const RESOURCES = join(__dirname, '..', 'resources');

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;

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
  hardenSession();
  registerIpc();
  Menu.setApplicationMenu(buildMenu());
  createMainWindow();
  checkForUpdates();
}

/** The page may use the clipboard and fullscreen; camera, microphone, location and the rest stay off. */
function hardenSession(): void {
  const ses = session.fromPartition(PARTITION);
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
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
  win.once('ready-to-show', () => win.show());

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

  // No connection and nothing cached yet: show a friendly page with a retry button instead of a blank window.
  win.webContents.on('did-fail-load', (_e, code, _description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted: a redirect or a newer navigation */) return;
    if (url.startsWith('file:')) return;
    const query = new URLSearchParams({ server: getServerUrl() }).toString();
    void win.loadFile(join(RESOURCES, 'offline.html'), { search: query });
  });

  void win.loadURL(getServerUrl());
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

/**
 * Installed builds (Windows installer, AppImage) update themselves from the server's /downloads feed.
 * The website itself is never "installed": the window always loads the current one.
 */
function checkForUpdates(): void {
  if (!app.isPackaged) return;
  void (async () => {
    try {
      autoUpdater.autoDownload = true;
      autoUpdater.setFeedURL({ provider: 'generic', url: await updateFeedUrl() });
      await autoUpdater.checkForUpdatesAndNotify(); // offline, or a package type that cannot self-update, ends up in the catch
    } catch {
      /* no update feed configured: harmless */
    }
  })();
}

/**
 * The website may call an API on another origin (its config.json says where), and that API is what serves /downloads.
 * Without a config.json, or when it names no API, the website itself serves them.
 */
export async function updateFeedUrl(): Promise<string> {
  const site = getServerUrl();
  try {
    const res = await net.fetch(`${site}/config.json`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const { apiUrl } = (await res.json()) as { apiUrl?: unknown };
      const api = typeof apiUrl === 'string' ? normaliseServerUrl(apiUrl) : null;
      if (api) return `${api}/downloads/`;
    }
  } catch {
    /* offline or no config.json: use the website */
  }
  return `${site}/downloads/`;
}
