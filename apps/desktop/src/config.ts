import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

interface Config {
  /** The website the window shows. Self-hosters change it from the menu. */
  serverUrl?: string;
  window?: WindowState;
  /** The version that last ran, to tell the person "updated to x" once after an update. */
  lastVersion?: string;
  /** Set right before a silent update restarts the app, so it comes back where the person was. */
  resume?: { url: string; minimized: boolean };
}

const file = () => join(app.getPath('userData'), 'config.json');

function read(): Config {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Config;
  } catch {
    return {};
  }
}

function write(config: Config): void {
  try {
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('could not save settings', e);
  }
}

/** Accepts only http(s) addresses and normalises them to an origin plus optional path, without a trailing slash. */
export function normaliseServerUrl(input: string): string | null {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return (url.origin + url.pathname).replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** The address built into this release (see scripts/prepare.mjs). */
export function bakedServerUrl(): string {
  try {
    const baked = JSON.parse(readFileSync(join(__dirname, 'default-server.json'), 'utf8')) as { serverUrl?: string };
    return normaliseServerUrl(baked.serverUrl ?? '') ?? 'http://localhost:3000';
  } catch {
    return 'http://localhost:3000';
  }
}

export const getServerUrl = (): string => normaliseServerUrl(read().serverUrl ?? '') ?? bakedServerUrl();

export function setServerUrl(url: string): string | null {
  const normalised = normaliseServerUrl(url);
  if (!normalised) return null;
  write({ ...read(), serverUrl: normalised });
  return normalised;
}

export const getLastVersion = (): string | null => read().lastVersion ?? null;
export const setLastVersion = (lastVersion: string): void => write({ ...read(), lastVersion });

/** Reads and clears the "come back here" note a silent update leaves; only an address on the server's origin is honoured. */
export function takeResume(serverOrigin: string | null): { url: string; minimized: boolean } | null {
  const config = read();
  if (!config.resume) return null;
  const { resume, ...rest } = config;
  write(rest);
  try {
    const url = new URL(resume.url);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== serverOrigin) return null;
    return { url: url.href, minimized: !!resume.minimized };
  } catch {
    return null;
  }
}
export const saveResume = (resume: { url: string; minimized: boolean }): void => write({ ...read(), resume });

export const getWindowState =(): WindowState => read().window ?? { width: 1280, height: 860, maximized: false };
export const saveWindowState = (window: WindowState): void => write({ ...read(), window });
