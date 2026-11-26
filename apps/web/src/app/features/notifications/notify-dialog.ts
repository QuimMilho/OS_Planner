import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { MUTE_PRESET_MINUTES } from '@os-planner/shared/chat';
import type {
  EffectiveSettingDto,
  NotificationSettingDto,
  NotifyLevel,
  SettingSource,
} from '@os-planner/shared';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { NotificationStore, type Scope, type SettingPatch } from '../../data/notification-store';

export interface NotifyDialogData {
  scope: Scope;
  /** What the dialog is about: "#general", "Team", the person's name. */
  title: string;
}

/**
 * What the person wants to hear about one place: how much (everything, only mentions, nothing, or what the place above says),
 * which kinds of mention to skip, a mute for a while, email and push. Every change is saved at once, and the box at the
 * bottom says what is in effect and where it comes from, so a setting that has no effect here is never a mystery.
 */
@Component({
  selector: 'app-notify-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <h2 mat-dialog-title>{{ 'notif.title' | transloco: { name: data.title } }}</h2>
    <mat-dialog-content data-notify-dialog>
      <fieldset>
        <legend>{{ 'notif.levelTitle' | transloco }}</legend>
        @for (l of levels; track l) {
          <label>
            <input
              type="radio"
              name="level"
              [value]="l"
              [ngModel]="row()?.level ?? 'inherit'"
              (ngModelChange)="set({ level: $event })"
              [attr.data-level]="l"
            />
            {{ 'notif.level.' + l | transloco }}
          </label>
        }
      </fieldset>

      <fieldset>
        <legend>{{ 'notif.suppressTitle' | transloco }}</legend>
        <label
          ><input
            type="checkbox"
            name="suppressEveryone"
            [ngModel]="!!row()?.suppressEveryone"
            (ngModelChange)="set({ suppressEveryone: $event || null })"
            data-suppress="everyone"
          />
          {{ 'notif.suppressEveryone' | transloco }}</label
        >
        <label
          ><input
            type="checkbox"
            name="suppressRoles"
            [ngModel]="!!row()?.suppressRoles"
            (ngModelChange)="set({ suppressRoles: $event || null })"
            data-suppress="roles"
          />
          {{ 'notif.suppressRoles' | transloco }}</label
        >
        @if (data.scope.scopeKind !== 'global') {
          <label
            ><input
              type="checkbox"
              name="suppressDirect"
              [ngModel]="!!row()?.suppressDirect"
              (ngModelChange)="set({ suppressDirect: $event || null })"
              data-suppress="direct"
            />
            {{ 'notif.suppressDirect' | transloco }}</label
          >
        }
      </fieldset>

      @if (data.scope.scopeKind !== 'global') {
        <fieldset>
          <legend>{{ 'notif.muteTitle' | transloco }}</legend>
          @if (eff()?.muted) {
            <p class="state" data-muted>
              <mat-icon>notifications_off</mat-icon>
              {{
                (eff()!.mutedUntil && !forever(eff()!.mutedUntil)
                  ? 'notif.mutedUntil'
                  : 'notif.mutedForever'
                ) | transloco: { time: until(eff()!.mutedUntil) }
              }}
              <button mat-button type="button" (click)="unmute()" data-unmute>
                {{ 'notif.unmute' | transloco }}
              </button>
            </p>
          }
          <div class="presets">
            @for (m of presets; track m) {
              <button
                mat-stroked-button
                type="button"
                (click)="mute(m)"
                [attr.data-mute]="m ?? 'forever'"
              >
                {{ 'notif.mute.' + (m ?? 'forever') | transloco }}
              </button>
            }
          </div>
        </fieldset>
      }

      <fieldset>
        <legend>{{ 'notif.emailTitle' | transloco }}</legend>
        <select
          name="email"
          [ngModel]="row()?.email ?? 'inherit'"
          (ngModelChange)="set({ email: $event })"
          data-email
          [attr.aria-label]="'notif.emailTitle' | transloco"
        >
          @for (e of emails; track e) {
            <option [value]="e">{{ 'notif.email.' + e | transloco }}</option>
          }
        </select>
        <label
          ><input
            type="checkbox"
            name="away"
            [ngModel]="row()?.emailOnlyWhenAway ?? true"
            (ngModelChange)="set({ emailOnlyWhenAway: $event })"
            data-away
          />
          {{ 'notif.onlyAway' | transloco }}</label
        >
      </fieldset>

      <fieldset>
        <legend>{{ 'notif.pushTitle' | transloco }}</legend>
        <select
          name="push"
          [ngModel]="pushValue()"
          (ngModelChange)="setPush($event)"
          data-push
          [attr.aria-label]="'notif.pushTitle' | transloco"
        >
          <option value="inherit">{{ 'notif.level.inherit' | transloco }}</option>
          <option value="on">{{ 'notif.pushOn' | transloco }}</option>
          <option value="off">{{ 'notif.pushOff' | transloco }}</option>
        </select>
      </fieldset>

      @if (eff(); as e) {
        <section class="effective" data-effective>
          <h3>{{ 'notif.effective' | transloco }}</h3>
          <ul>
            <li data-eff="level">
              {{
                'notif.effLevel'
                  | transloco
                    : {
                        level: ('notif.level.' + e.level | transloco),
                        from: where(e.sources.level),
                      }
              }}
            </li>
            @if (e.muted) {
              <li data-eff="mute">
                {{ 'notif.effMuted' | transloco: { from: where(e.sources.mute) } }}
              </li>
            }
            <li data-eff="email">
              {{
                'notif.effEmail'
                  | transloco
                    : {
                        email: ('notif.email.' + e.email | transloco),
                        from: where(e.sources.email),
                      }
              }}
            </li>
            <li data-eff="push">
              {{ (e.push ? 'notif.effPushOn' : 'notif.effPushOff') | transloco }}
            </li>
          </ul>
        </section>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" mat-dialog-close cdkFocusInitial>
        {{ 'common.close' | transloco }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    fieldset {
      border: 1px solid var(--border);
      border-radius: 8px;
      margin: 0 0 12px;
      padding: 8px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    legend {
      font-weight: 600;
      font-size: 13px;
      padding: 0 4px;
    }
    label {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    select {
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--surface-1);
      color: var(--text);
      font: inherit;
    }
    .presets {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .state {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 0 0 6px;
      color: var(--mat-sys-error);
    }
    .effective h3 {
      margin: 0 0 4px;
      font-size: 13px;
    }
    .effective ul {
      margin: 0;
      padding-left: 18px;
      color: var(--text-dim);
      font-size: 13px;
    }
  `,
})
export class NotifyDialog {
  protected readonly data = inject<NotifyDialogData>(MAT_DIALOG_DATA);
  private readonly store = inject(NotificationStore);
  private readonly notify = inject(Notify);
  private readonly lang = inject(Language);
  protected readonly levels: NotifyLevel[] = ['all', 'mentions', 'none', 'inherit'];
  protected readonly emails = ['inherit', 'off', 'mentions', 'all'];
  protected readonly presets = MUTE_PRESET_MINUTES;
  protected readonly row = signal<NotificationSettingDto | null>(null);
  protected readonly eff = signal<EffectiveSettingDto | null>(null);
  protected readonly pushValue = computed(() =>
    this.row()?.push === null || this.row()?.push === undefined
      ? 'inherit'
      : this.row()!.push
        ? 'on'
        : 'off',
  );

  constructor() {
    effect(() => {
      this.store.settingsVersion();
      untracked(() => void this.load());
    });
  }

  private async load(): Promise<void> {
    try {
      const [all, eff] = await Promise.all([
        this.store.settings(),
        this.store.effective(this.data.scope),
      ]);
      const { scopeKind, scopeId } = this.data.scope;
      this.row.set(
        all.find((s) => s.scopeKind === scopeKind && (s.scopeId ?? null) === scopeId) ?? null,
      );
      this.eff.set(eff);
    } catch {
      this.notify.error('common.offlineAction');
    }
  }

  protected async set(patch: SettingPatch): Promise<void> {
    try {
      await this.store.put(this.data.scope, patch);
    } catch (e) {
      this.notify.error(
        (e as { offline?: boolean }).offline ? 'common.offlineAction' : 'errors.generic',
      );
    }
    await this.load();
  }

  protected setPush(v: string): Promise<void> {
    return this.set({ push: v === 'inherit' ? null : v === 'on' });
  }

  protected async mute(minutes: number | null): Promise<void> {
    try {
      await this.store.mute(this.data.scope, minutes);
    } catch {
      this.notify.error('common.offlineAction');
    }
    await this.load();
  }

  protected async unmute(): Promise<void> {
    await this.mute(false as never);
  }

  protected forever(iso: string | null): boolean {
    return !iso || new Date(iso).getFullYear() > 9000;
  }

  protected until(iso: string | null): string {
    return iso && !this.forever(iso) ? new Date(iso).toLocaleString() : '';
  }

  /** The name of the place a value comes from. */
  protected where(s: SettingSource): string {
    const key =
      s.scopeKind === 'default'
        ? 'default'
        : s.scopeKind === this.data.scope.scopeKind && s.scopeId === this.data.scope.scopeId
          ? 'here'
          : s.scopeKind;
    return this.lang.t(`notif.where.${key}`);
  }
}

/** Opens the dialog; one place to call from every menu. */
export function openNotifyDialog(dialog: MatDialog, data: NotifyDialogData): void {
  dialog.open(NotifyDialog, { data, width: '460px', maxWidth: '96vw', autoFocus: false });
}
