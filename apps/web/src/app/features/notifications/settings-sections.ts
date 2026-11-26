import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import type { BlockDto, PushDeviceDto, QuietHoursDto } from '@os-planner/shared';
import { Notify } from '../../core/notify';
import { DmStore } from '../../data/dm-store';
import { NotificationStore } from '../../data/notification-store';
import { openNotifyDialog } from './notify-dialog';

/** Settings → Privacy: the people the person blocked. */
@Component({
  selector: 'app-blocked-users',
  imports: [MatButtonModule, TranslocoPipe],
  template: `
    <h3>{{ 'settings.privacy.blocked' | transloco }}</h3>
    <ul class="blocked" data-blocked-list>
      @for (b of blocks(); track b.userId) {
        <li [attr.data-blocked]="b.displayName">
          <span>{{ b.displayName ?? ('chat.deletedUser' | transloco) }}</span>
          <button mat-button type="button" (click)="unblock(b)" data-action="unblock">
            {{ 'dm.unblock' | transloco }}
          </button>
        </li>
      } @empty {
        <li class="muted" data-blocked-none>{{ 'settings.privacy.noBlocked' | transloco }}</li>
      }
    </ul>
  `,
  styles: `
    h3 {
      margin: 12px 0 4px;
      font-size: 14px;
    }
    .blocked {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 2px 0;
    }
    .muted {
      color: var(--text-dim);
    }
  `,
})
export class BlockedUsers implements OnInit {
  private readonly dms = inject(DmStore);
  private readonly notify = inject(Notify);
  protected readonly blocks = signal<BlockDto[]>([]);

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.blocks.set(await this.dms.blocks());
    } catch {
      /* offline: nothing to show */
    }
  }

  protected async unblock(b: BlockDto): Promise<void> {
    try {
      await this.dms.block(b.userId, false);
      await this.load();
    } catch {
      this.notify.error('common.offlineAction');
    }
  }
}

const DAYS = [1, 2, 3, 4, 5, 6, 0];

/** Settings → Notifications: defaults for every place, quiet hours, and Web Push for this device. */
@Component({
  selector: 'app-notification-settings',
  imports: [FormsModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <p class="muted hint">{{ 'notif.settingsHint' | transloco }}</p>
    <button
      mat-stroked-button
      type="button"
      (click)="defaults()"
      data-action="notification-defaults"
    >
      <mat-icon>tune</mat-icon>{{ 'notif.defaults' | transloco }}
    </button>

    <h3>{{ 'notif.quietTitle' | transloco }}</h3>
    <form class="quiet" (ngSubmit)="saveQuiet()" data-quiet-hours>
      <label class="toggle"
        ><input type="checkbox" name="qenabled" [(ngModel)]="quiet.enabled" data-quiet="enabled" />
        {{ 'notif.quietEnable' | transloco }}</label
      >
      <div class="times">
        <label
          >{{ 'notif.quietFrom' | transloco }}
          <input type="time" name="qfrom" [(ngModel)]="quiet.from" data-quiet="from"
        /></label>
        <label
          >{{ 'notif.quietTo' | transloco }}
          <input type="time" name="qto" [(ngModel)]="quiet.to" data-quiet="to"
        /></label>
      </div>
      <div class="days" role="group" [attr.aria-label]="'notif.quietDays' | transloco">
        @for (d of days; track d) {
          <label class="day"
            ><input
              type="checkbox"
              [name]="'qday' + d"
              [ngModel]="quiet.days.includes(d)"
              (ngModelChange)="toggleDay(d, $event)"
            />{{ 'notif.day.' + d | transloco }}</label
          >
        }
      </div>
      <p class="muted hint">{{ 'notif.quietHint' | transloco: { zone: quiet.timeZone } }}</p>
      <button mat-flat-button type="submit" data-action="save-quiet">
        {{ 'common.save' | transloco }}
      </button>
    </form>

    @if (pushAvailable()) {
      <h3>{{ 'push.title' | transloco }}</h3>
      <p class="muted hint">{{ 'push.hint' | transloco }}</p>
      @if (thisDevice()) {
        <p class="state" data-push-state="on">
          <mat-icon>notifications_active</mat-icon>{{ 'push.on' | transloco }}
        </p>
        <button mat-stroked-button type="button" (click)="disable()" data-action="push-disable">
          {{ 'push.disable' | transloco }}
        </button>
      } @else {
        <button mat-flat-button type="button" (click)="enable()" data-action="push-enable">
          <mat-icon>notifications</mat-icon>{{ 'push.enable' | transloco }}
        </button>
        @if (denied()) {
          <p class="warn" data-push-denied>{{ 'push.denied' | transloco }}</p>
        }
      }
      <h4>{{ 'push.devices' | transloco }}</h4>
      <ul class="devices" data-push-devices>
        @for (d of devices(); track d.id) {
          <li>
            <span>{{ device(d) }}</span>
            <button mat-button type="button" (click)="remove(d)" data-action="push-remove">
              {{ 'push.remove' | transloco }}
            </button>
          </li>
        } @empty {
          <li class="muted">{{ 'push.noDevices' | transloco }}</li>
        }
      </ul>
    }
  `,
  styles: `
    h3 {
      margin: 16px 0 4px;
      font-size: 14px;
    }
    h4 {
      margin: 12px 0 2px;
      font-size: 13px;
    }
    .muted {
      color: var(--text-dim);
    }
    .hint {
      margin: 2px 0 8px;
      font-size: 13px;
    }
    .quiet {
      display: flex;
      flex-direction: column;
      gap: 8px;
      align-items: flex-start;
    }
    .times {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }
    .times label {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 13px;
    }
    input[type='time'] {
      padding: 5px 8px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface-1);
      color: var(--text);
      font: inherit;
    }
    .days {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .day {
      display: flex;
      align-items: center;
      gap: 3px;
      font-size: 13px;
    }
    .toggle {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .devices {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .devices li {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .state {
      display: flex;
      align-items: center;
      gap: 6px;
      color: #2f9e44;
      margin: 4px 0;
    }
    .warn {
      color: var(--mat-sys-error);
    }
  `,
})
export class NotificationSettings implements OnInit {
  private readonly store = inject(NotificationStore);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);

  protected readonly days = DAYS;
  protected quiet: QuietHoursDto = {
    enabled: false,
    from: '22:00',
    to: '07:00',
    days: [0, 1, 2, 3, 4, 5, 6],
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  };
  protected readonly pushAvailable = signal(false);
  protected readonly thisDevice = signal(false);
  protected readonly denied = signal(false);
  protected readonly devices = signal<PushDeviceDto[]>([]);

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const q = await this.store.quietHours();
      if (q)
        this.quiet = {
          ...q,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || q.timeZone,
        };
    } catch {
      /* offline: the defaults show */
    }
    // The option is offered only when this server has push switched on and this browser can do it.
    this.pushAvailable.set(this.store.pushSupported && (await this.store.vapidKey()) !== null);
    if (this.pushAvailable()) await this.refreshDevices();
  }

  private async refreshDevices(): Promise<void> {
    this.thisDevice.set((await this.store.currentSubscription()) !== null);
    try {
      this.devices.set(await this.store.devices());
    } catch {
      this.devices.set([]);
    }
  }

  protected defaults(): void {
    openNotifyDialog(this.dialog, { scope: { scopeKind: 'global', scopeId: null }, title: '' });
  }

  protected toggleDay(day: number, on: boolean): void {
    this.quiet = {
      ...this.quiet,
      days: on ? [...new Set([...this.quiet.days, day])] : this.quiet.days.filter((d) => d !== day),
    };
  }

  protected async saveQuiet(): Promise<void> {
    try {
      await this.store.setQuietHours(this.quiet);
      this.notify.info('settings.saved');
    } catch {
      this.notify.error('common.offlineAction');
    }
  }

  protected async enable(): Promise<void> {
    this.denied.set(false);
    try {
      const result = await this.store.enablePush();
      if (result === 'denied') this.denied.set(true);
    } catch {
      this.notify.error('push.failed');
    }
    await this.refreshDevices();
  }

  protected async disable(): Promise<void> {
    await this.store.disablePush();
    await this.refreshDevices();
  }

  protected async remove(d: PushDeviceDto): Promise<void> {
    await this.store.removeDevice(d.id).catch(() => undefined);
    await this.refreshDevices();
  }

  protected device(d: PushDeviceDto): string {
    const ua = d.userAgent ?? '';
    const browser = /Edg\//.test(ua)
      ? 'Edge'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
    const os = /Windows/.test(ua)
      ? 'Windows'
      : /Android/.test(ua)
        ? 'Android'
        : /iPhone|iPad/.test(ua)
          ? 'iOS'
          : /Mac OS/.test(ua)
            ? 'macOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : '';
    return `${os ? `${browser} · ${os}` : browser} (${d.service})`;
  }
}
