import { app, net, powerMonitor, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getServerUrl, normaliseServerUrl, saveResume } from './config';
import { shouldInstallNow } from './updater-policy';

/**
 * Installed builds update themselves from the server's /downloads feed, without asking: the update downloads in the
 * background and is installed (the app restarts where the person was) once nobody is using the window. If that moment
 * never comes, it installs when the app is quit. The website itself is never "installed": the window always loads the current one.
 */

const CHECK_EVERY_MS = 4 * 60 * 60_000;
const INSTALL_POLL_MS = 60_000;
const GRACE_MS = 30_000;
const MAX_LOG_BYTES = 256 * 1024;

export interface UpdaterHooks {
  window: () => BrowserWindow | null;
  /** True while the website says there is a call, an open dialog or unsaved work. */
  webBusy: () => boolean;
}

/** A tiny log next to the settings (userData/logs/updater.log); it is cut to its newer half once it passes 256 KB. */
function createLog() {
  const dir = () => join(app.getPath('userData'), 'logs');
  const file = () => join(dir(), 'updater.log');
  const write = (level: string, args: unknown[]) => {
    try {
      mkdirSync(dir(), { recursive: true });
      try {
        if (statSync(file()).size > MAX_LOG_BYTES) writeFileSync(file(), readFileSync(file(), 'utf8').slice(-MAX_LOG_BYTES / 2));
      } catch {
        /* no log yet */
      }
      const text = args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      appendFileSync(file(), `${new Date().toISOString()} ${level} ${text}\n`);
    } catch {
      /* a log that cannot be written must never break the app */
    }
  };
  return {
    info: (...args: unknown[]) => write('info', args),
    warn: (...args: unknown[]) => write('warn', args),
    error: (...args: unknown[]) => write('error', args),
    debug: (...args: unknown[]) => write('debug', args),
  };
}

/** Whether this kind of install can replace itself: not the portable .exe, and on Linux only the AppImage (deb/rpm would need root). */
export function canSelfUpdate(): boolean {
  if (!app.isPackaged) return false;
  if (process.env['PORTABLE_EXECUTABLE_FILE']) return false;
  if (process.platform === 'linux' && !process.env['APPIMAGE']) return false;
  return true;
}

export function startUpdater(hooks: UpdaterHooks): void {
  if (!canSelfUpdate()) return;
  const log = createLog();
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;

  let downloaded = false;
  let installing = false;
  let graceTimer: NodeJS.Timeout | null = null;

  const check = async () => {
    if (downloaded) return;
    try {
      // The feed is looked up every time: the person may have changed the server since the last check.
      autoUpdater.setFeedURL({ provider: 'generic', url: await updateFeedUrl() });
      await autoUpdater.checkForUpdates();
    } catch (e) {
      log.warn('update check failed:', e instanceof Error ? e.message : String(e)); // offline or no feed: harmless
    }
  };

  const tryInstall = () => {
    if (!downloaded || installing) return;
    const win = hooks.window();
    const minimized = !win || win.isDestroyed() || win.isMinimized();
    const ok = shouldInstallNow({
      webBusy: hooks.webBusy(),
      visible: !!win && !win.isDestroyed() && win.isVisible(),
      minimized,
      focused: !!win && !win.isDestroyed() && win.isFocused(),
      idleSeconds: powerMonitor.getSystemIdleTime(),
    });
    if (!ok) return;
    installing = true;
    const current = win && !win.isDestroyed() ? win.webContents.getURL() : '';
    if (/^https?:/i.test(current)) saveResume({ url: current, minimized });
    log.info('installing the downloaded update now');
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (e) {
      installing = false;
      log.error('could not install the update:', e);
    }
  };

  /** Hiding, minimising or leaving the window starts a short grace period, then the install is considered at once. */
  const considerSoon = () => {
    if (!downloaded || graceTimer) return;
    graceTimer = setTimeout(() => {
      graceTimer = null;
      tryInstall();
    }, GRACE_MS);
  };
  const watchWindow = (win: BrowserWindow | null) => {
    if (!win) return;
    win.on('minimize', considerSoon);
    win.on('hide', considerSoon);
    win.on('blur', considerSoon);
  };

  autoUpdater.on('update-downloaded', (info) => {
    log.info('update downloaded:', info.version);
    downloaded = true;
    watchWindow(hooks.window());
  });
  autoUpdater.on('error', (e) => log.error('updater error:', e));

  setInterval(tryInstall, INSTALL_POLL_MS).unref(); // does nothing until an update has been downloaded
  void check();
  setInterval(() => void check(), CHECK_EVERY_MS).unref();
  powerMonitor.on('resume', () => void check());
  app.on('browser-window-created', (_e, win) => {
    if (downloaded) watchWindow(win);
  });
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
