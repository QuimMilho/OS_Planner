import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { NavigationEnd, Router } from '@angular/router';
import { SwUpdate, type VersionEvent } from '@angular/service-worker';
import { filter } from 'rxjs';
import { Notify } from './notify';
import { Platform } from './platform';

const CHECK_EVERY_MS = 30 * 60_000;
const TICK_MS = 30_000;
/** A tab or window that has been out of sight this long may be replaced. */
const HIDDEN_MS = 15_000;
/** Nobody has touched the app for this long. */
const IDLE_MS = 10 * 60_000;
/** After an update the next automatic one waits this long, so a failing update can never become a reload loop. */
const COOLDOWN_MS = 60_000;
const FLAG = 'os_planner.updated';

/**
 * Keeps the app current without asking. The service worker downloads a new version in the background; this service
 * switches to it (a reload) at a moment when nothing is lost: right after the person moved to another page, while the
 * window is out of sight, or after a long pause, and never during a call, with a dialog open, or with unsaved work.
 * Pages that hold unsaved state register with `hold()` / `holdWhile()`.
 *
 * Inside the desktop app the same service also tells the shell when it is busy, so the shell's own (restarting) update waits too.
 */
@Injectable({ providedIn: 'root' })
export class AppUpdates {
  private readonly sw = inject(SwUpdate, { optional: true });
  private readonly router = inject(Router);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  private readonly platform = inject(Platform);

  private readonly holds = signal(0);
  private readonly dialogs = signal(0);
  private readonly draft = signal(false);

  /** A new version is downloaded and waiting. */
  readonly ready = signal(false);
  /** Something would be lost by reloading right now (a call, a dialog, unsaved work, a half-written message). */
  readonly busy = computed(() => this.holds() > 0 || this.dialogs() > 0 || this.draft());

  private unrecoverable = false;
  private applying = false;
  private lastInput = Date.now();
  private hiddenSince: number | null = document.visibilityState === 'hidden' ? Date.now() : null;
  private appliedAt = 0;

  constructor() {
    this.announceUpdate();
    this.watchBusy();
    if (!this.sw?.isEnabled) return;
    const sw = this.sw;

    sw.versionUpdates
      .pipe(filter((e: VersionEvent) => e.type === 'VERSION_READY' || e.type === 'VERSION_INSTALLATION_FAILED'))
      .subscribe((e) => {
        if (e.type === 'VERSION_READY') {
          this.ready.set(true);
          this.evaluate(false);
        } else {
          console.warn('a new version of the app could not be installed; trying again at the next check');
        }
      });
    // The cached copy is damaged: only a reload repairs it.
    sw.unrecoverable.subscribe(() => {
      this.unrecoverable = true;
      this.ready.set(true);
      this.evaluate(false);
    });

    const check = () => void sw.checkForUpdate().catch(() => undefined);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.hiddenSince = null;
        check();
      } else {
        this.hiddenSince = Date.now();
      }
      this.evaluate(false);
    });
    addEventListener('online', check);
    setInterval(check, CHECK_EVERY_MS);

    for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) {
      document.addEventListener(type, () => (this.lastInput = Date.now()), { passive: true, capture: true });
    }
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => this.evaluate(true));
    setInterval(() => this.evaluate(false), TICK_MS);
    // Whatever was holding the update back has let go.
    effect(() => {
      if (!this.busy()) queueMicrotask(() => this.evaluate(false));
    });
  }

  /** Marks the app as busy until the returned function is called. */
  hold(): () => void {
    let released = false;
    this.holds.update((n) => n + 1);
    return () => {
      if (released) return;
      released = true;
      this.holds.update((n) => n - 1);
    };
  }

  /** Busy for as long as `source()` is true. Call from a constructor (it needs an injection context); it lets go when the component is destroyed. */
  holdWhile(source: () => boolean): void {
    effect((onCleanup) => {
      if (source()) onCleanup(this.hold());
    });
  }

  private evaluate(justNavigated: boolean): void {
    if (!this.ready() || this.applying || this.busy()) return;
    if (Date.now() - this.appliedAt < COOLDOWN_MS) return;
    if (justNavigated || this.hiddenLongEnough() || this.idleLongEnough()) void this.apply();
  }

  private hiddenLongEnough(): boolean {
    return document.visibilityState === 'hidden' && this.hiddenSince !== null && Date.now() - this.hiddenSince >= HIDDEN_MS;
  }

  private idleLongEnough(): boolean {
    return Date.now() - this.lastInput >= IDLE_MS;
  }

  private async apply(): Promise<void> {
    this.applying = true;
    try {
      sessionStorage.setItem(FLAG, String(Date.now()));
    } catch {
      /* private mode: the update still happens, only the "updated" note is missing */
    }
    try {
      if (!this.unrecoverable) await this.sw?.activateUpdate();
    } catch {
      /* reload anyway: the new version is picked up on the way in */
    }
    location.reload();
  }

  /** Right after an update: one small note, once. */
  private announceUpdate(): void {
    try {
      const at = Number(sessionStorage.getItem(FLAG));
      if (at) {
        sessionStorage.removeItem(FLAG);
        this.appliedAt = at;
        this.notify.info('app.updated');
      }
    } catch {
      /* no storage: no note */
    }
    const from = this.platform.desktop?.updatedFrom;
    if (from) this.notify.info('app.desktopUpdated', { version: this.platform.desktop?.version ?? '' });
  }

  private watchBusy(): void {
    // Dialogs and half-written text are not signals anywhere else, so they are followed here.
    this.dialog.afterOpened.subscribe(() => this.dialogs.set(this.dialog.openDialogs.length));
    this.dialog.afterAllClosed.subscribe(() => this.dialogs.set(0));
    const refresh = () => setTimeout(() => this.draft.set(hasDraft()), 0);
    document.addEventListener('input', refresh, { capture: true, passive: true });
    document.addEventListener('focusin', refresh, { capture: true, passive: true });
    document.addEventListener('focusout', refresh, { capture: true, passive: true });
    // The shell (desktop app) holds its own restart back while this is true.
    const desktop = this.platform.desktop;
    if (desktop?.setBusy) effect(() => desktop.setBusy?.(this.busy()));
  }
}

/** A focused multi-line field or free-text area (a chat message, a task comment) that has text nobody has sent or saved yet. */
function hasDraft(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return el.value.trim().length > 0;
  // The page editor is co-edited and saved as it is typed; any other editable area is a draft.
  if (el.isContentEditable && !el.closest('.ProseMirror')) return (el.textContent ?? '').trim().length > 0;
  return false;
}
