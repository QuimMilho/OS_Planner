import { existsSync } from 'node:fs';
import type { Env } from '../config/env.js';

const CANDIDATES: Record<string, string[]> = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge'],
};

/** The browser used for PDF rendering: CHROME_PATH if set, otherwise the first well-known install. */
export function findChrome(env: Pick<Env, 'CHROME_PATH'>): string | null {
  if (env.CHROME_PATH) return existsSync(env.CHROME_PATH) ? env.CHROME_PATH : null;
  return (CANDIDATES[process.platform] ?? []).find((p) => existsSync(p)) ?? null;
}
