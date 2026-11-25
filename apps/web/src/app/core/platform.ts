import { Injectable, signal } from '@angular/core';

/** Optional bridge the desktop shell exposes. The web app works fully without it. */
export interface DesktopBridge {
  isDesktop: true;
  version: string;
  platform: string;
  /** Opens the native "Save as" dialog and writes the file. Returns false if the user cancelled. */
  saveFile(data: ArrayBuffer, suggestedName: string): Promise<boolean>;
  onMenuCommand(callback: (command: string) => void): void;
}

declare global {
  interface Window {
    notesDesktop?: DesktopBridge;
  }
  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  }
}

export type RunMode = 'browser' | 'pwa' | 'desktop';

/**
 * Where the app is running. This only ever selects an *implementation* (e.g. the native save
 * dialog instead of a browser download); it never turns a feature on or off.
 */
@Injectable({ providedIn: 'root' })
export class Platform {
  readonly desktop = typeof window !== 'undefined' ? (window.notesDesktop ?? null) : null;
  readonly mode: RunMode = this.desktop
    ? 'desktop'
    : typeof matchMedia !== 'undefined' && (matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone)
      ? 'pwa'
      : 'browser';

  readonly os: 'windows' | 'linux' | 'mac' | 'android' | 'ios' | 'other' = detectOs();

  /** Saves a file the way the current environment prefers. */
  async saveBlob(blob: Blob, filename: string): Promise<void> {
    if (this.desktop) {
      await this.desktop.saveFile(await blob.arrayBuffer(), filename);
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

function detectOs(): Platform['os'] {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'mac';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return 'other';
}

/** Captures the browser's install prompt so the site can offer an "Install app" button. */
@Injectable({ providedIn: 'root' })
export class InstallPrompt {
  private deferred: BeforeInstallPromptEvent | null = null;
  readonly canInstall = signal(false);
  readonly installed = signal(false);

  constructor() {
    addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); // keep it for our own button
      this.deferred = e as BeforeInstallPromptEvent;
      this.canInstall.set(true);
    });
    addEventListener('appinstalled', () => {
      this.deferred = null;
      this.canInstall.set(false);
      this.installed.set(true);
    });
  }

  async install(): Promise<boolean> {
    if (!this.deferred) return false;
    await this.deferred.prompt();
    const { outcome } = await this.deferred.userChoice;
    this.deferred = null;
    this.canInstall.set(false);
    return outcome === 'accepted';
  }
}
