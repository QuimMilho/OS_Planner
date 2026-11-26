import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type {
  EffectiveSettingDto,
  NotificationCountDto,
  NotificationDto,
  NotificationPageDto,
  NotificationReadEvent,
  NotificationSettingDto,
  PushDeviceDto,
  QuietHoursDto,
  ScopeKind,
  VapidKeyDto,
} from '@os-planner/shared';
import { AuthStore, toProblem } from '../core/auth-store';
import { Language } from '../core/i18n';
import { Platform } from '../core/platform';
import { RealtimeService } from '../core/realtime';

const EMPTY: NotificationCountDto = { unread: 0, mentions: 0, byTeam: {}, dms: 0 };

/** One place a setting is about. `scopeId` is null for the person's global settings. */
export interface Scope {
  scopeKind: ScopeKind;
  scopeId: string | null;
}

export type SettingPatch = Partial<
  Pick<
    NotificationSettingDto,
    | 'level'
    | 'suppressEveryone'
    | 'suppressRoles'
    | 'suppressDirect'
    | 'mutedUntil'
    | 'email'
    | 'emailOnlyWhenAway'
    | 'push'
  >
>;

/**
 * Everything about being told: the inbox and its counters (kept current by the server's events), the settings of each place,
 * quiet hours, and Web Push. Nothing is cached for offline use: a bell that says "3 new" must be true, and offline there is
 * nothing new to hear about.
 */
@Injectable({ providedIn: 'root' })
export class NotificationStore {
  private readonly http = inject(HttpClient);
  private readonly rt = inject(RealtimeService);
  private readonly auth = inject(AuthStore);
  private readonly lang = inject(Language);
  private readonly platform = inject(Platform);

  readonly count = signal<NotificationCountDto>(EMPTY);
  /** The inbox as loaded so far, newest first. */
  readonly items = signal<NotificationDto[]>([]);
  readonly nextCursor = signal<string | null>(null);
  readonly inboxLoaded = signal(false);
  /** The inbox panel is open. */
  readonly panelOpen = signal(false);
  /** Bumped whenever a setting changed (here or on another device): dialogs read again. */
  readonly settingsVersion = signal(0);

  constructor() {
    effect(() => {
      if (this.auth.userId()) untracked(() => void this.refreshCount());
      else untracked(() => this.reset());
    });
    this.rt.on<NotificationDto>('notification.created').subscribe((n) => this.onCreated(n));
    this.rt.on<NotificationReadEvent>('notification.read').subscribe((e) => this.onRead(e));
    this.rt
      .on('notification.settings.changed')
      .subscribe(() => this.settingsVersion.update((v) => v + 1));
    this.rt.resumed.subscribe(() => void this.refreshCount());
  }

  private reset(): void {
    this.count.set(EMPTY);
    this.items.set([]);
    this.nextCursor.set(null);
    this.inboxLoaded.set(false);
  }

  // ---------------------------------------------------------------- the inbox

  async refreshCount(): Promise<void> {
    try {
      this.count.set(
        await firstValueFrom(this.http.get<NotificationCountDto>('/api/notifications/count')),
      );
    } catch {
      /* offline: the last numbers stay */
    }
  }

  /** The first page (or the next one) of the inbox. */
  async load(more = false, mentionsOnly = false): Promise<void> {
    try {
      const params: Record<string, string> = { limit: '30' };
      if (mentionsOnly) params['mentions'] = 'true';
      if (more && this.nextCursor()) params['cursor'] = this.nextCursor()!;
      const page = await firstValueFrom(
        this.http.get<NotificationPageDto>('/api/notifications', { params }),
      );
      this.items.update((old) =>
        more ? [...old, ...page.items.filter((p) => !old.some((o) => o.id === p.id))] : page.items,
      );
      this.nextCursor.set(page.nextCursor);
      this.inboxLoaded.set(true);
    } catch {
      this.inboxLoaded.set(true);
    }
  }

  private onCreated(n: NotificationDto): void {
    this.count.update((c) => ({
      unread: c.unread + 1,
      mentions: c.mentions + (n.kind.startsWith('mention_') || n.kind === 'reply' ? 1 : 0),
      byTeam:
        n.teamId && (n.kind.startsWith('mention_') || n.kind === 'reply')
          ? { ...c.byTeam, [n.teamId]: (c.byTeam[n.teamId] ?? 0) + 1 }
          : c.byTeam,
      dms: c.dms + (n.kind === 'dm' ? 1 : 0),
    }));
    if (this.inboxLoaded()) this.items.update((old) => [n, ...old.filter((o) => o.id !== n.id)]);
    this.nativeNotification(n);
  }

  /** In the desktop app a notification shows as the operating system's own while the window is not in use. */
  private nativeNotification(n: NotificationDto): void {
    if (this.platform.mode !== 'desktop' || typeof Notification === 'undefined') return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    if (Notification.permission !== 'granted') return;
    const actor = n.actorName ?? this.lang.t('chat.deletedUser');
    const body =
      n.redacted || !n.summary
        ? this.lang.t(`notif.kind.${n.kind}`, { name: actor })
        : `${actor}: ${n.summary}`;
    try {
      new Notification(n.channelName ? `#${n.channelName}` : actor, {
        body,
        tag: n.channelId ?? n.id,
      });
    } catch {
      /* the operating system refused: the badge still shows it */
    }
  }

  private onRead(e: NotificationReadEvent): void {
    if (e.all) this.items.update((old) => old.map((n) => ({ ...n, read: true })));
    else if (e.ids.length)
      this.items.update((old) => old.map((n) => (e.ids.includes(n.id) ? { ...n, read: true } : n)));
    void this.refreshCount();
  }

  async markRead(ids: string[] | 'all'): Promise<void> {
    const everything = ids === 'all';
    if (!everything && !ids.length) return;
    this.items.update((old) =>
      old.map((n) => (everything || ids.includes(n.id) ? { ...n, read: true } : n)),
    );
    try {
      await firstValueFrom(
        this.http.post('/api/notifications/read', everything ? { all: true } : { ids }),
      );
    } catch {
      /* offline: it shows as unread again at the next refresh, which is the honest state */
    }
    await this.refreshCount();
  }

  // ---------------------------------------------------------------- settings

  settings(): Promise<NotificationSettingDto[]> {
    return firstValueFrom(this.http.get<NotificationSettingDto[]>('/api/notification-settings'));
  }

  async put(scope: Scope, patch: SettingPatch): Promise<void> {
    try {
      await firstValueFrom(this.http.put('/api/notification-settings', { ...scope, ...patch }));
    } catch (e) {
      throw toProblem(e);
    }
  }

  /** Mutes for a number of minutes (null = until turned back on); `false` turns it off. */
  async mute(scope: Scope, minutes: number | null | false): Promise<void> {
    const until =
      minutes === false
        ? null
        : minutes === null
          ? '9999-12-31T23:59:59.000Z'
          : new Date(Date.now() + minutes * 60_000).toISOString();
    try {
      await firstValueFrom(this.http.post('/api/notification-settings/mute', { ...scope, until }));
    } catch (e) {
      throw toProblem(e);
    }
  }

  effective(scope: Scope): Promise<EffectiveSettingDto> {
    return firstValueFrom(
      this.http.get<EffectiveSettingDto>('/api/notification-settings/effective', {
        params: {
          scopeKind: scope.scopeKind,
          ...(scope.scopeId ? { scopeId: scope.scopeId } : {}),
        },
      }),
    );
  }

  async quietHours(): Promise<QuietHoursDto | null> {
    return (
      (await firstValueFrom(
        this.http.get<QuietHoursDto | null>('/api/notifications/quiet-hours'),
      )) ?? null
    );
  }

  async setQuietHours(value: QuietHoursDto): Promise<void> {
    try {
      await firstValueFrom(this.http.put('/api/notifications/quiet-hours', value));
    } catch (e) {
      throw toProblem(e);
    }
  }

  // ---------------------------------------------------------------- Web Push

  /** The browser can do it at all (a service worker and the Push API). */
  get pushSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      typeof Notification !== 'undefined'
    );
  }

  /** The server's key; null when push is switched off on this server (the option is then hidden). */
  async vapidKey(): Promise<string | null> {
    try {
      return (await firstValueFrom(this.http.get<VapidKeyDto>('/api/push/vapid-key'))).publicKey;
    } catch {
      return null;
    }
  }

  async currentSubscription(): Promise<PushSubscription | null> {
    if (!this.pushSupported) return null;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      return (await registration?.pushManager.getSubscription()) ?? null;
    } catch {
      return null;
    }
  }

  /** Asks the browser for permission (call it from a click), subscribes this device and tells the server. */
  async enablePush(): Promise<'enabled' | 'denied' | 'unsupported'> {
    const key = await this.vapidKey();
    if (!key || !this.pushSupported) return 'unsupported';
    if ((await Notification.requestPermission()) !== 'granted') return 'denied';
    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(key),
      }));
    const json = subscription.toJSON();
    await firstValueFrom(
      this.http.post('/api/push/subscribe', {
        endpoint: subscription.endpoint,
        keys: json.keys,
        userAgent: navigator.userAgent.slice(0, 300),
      }),
    );
    return 'enabled';
  }

  async disablePush(): Promise<void> {
    const subscription = await this.currentSubscription();
    if (!subscription) return;
    try {
      await firstValueFrom(
        this.http.request('DELETE', '/api/push/subscribe', {
          body: { endpoint: subscription.endpoint },
        }),
      );
    } catch {
      /* the server forgets it when the push service says it is gone */
    }
    await subscription.unsubscribe().catch(() => false);
  }

  devices(): Promise<PushDeviceDto[]> {
    return firstValueFrom(this.http.get<PushDeviceDto[]>('/api/push/devices'));
  }

  removeDevice(id: string): Promise<unknown> {
    return firstValueFrom(this.http.delete(`/api/push/devices/${id}`));
  }
}

function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded =
    value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
