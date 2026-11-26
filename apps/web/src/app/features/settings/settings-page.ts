import { HttpClient } from '@angular/common/http';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { THEMES, type Locale, type SessionDto, type Theme } from '@os-planner/shared';
import { AuthStore, toProblem } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { QuotaStore } from '../../core/quota';
import { ThemeService } from '../../core/theme';
import { sendWithCtrl, setSendWithCtrl } from '../chat/chat-composer';
import { BlockedUsers, NotificationSettings } from '../notifications/settings-sections';
import { AppsPanel } from '../site/apps-panel';

@Component({
  selector: 'app-settings-page',
  imports: [FormsModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule, TranslocoPipe, AppsPanel, BlockedUsers, NotificationSettings],
  template: `
    <div class="wrap">
      <h1>{{ 'nav.settings' | transloco }}</h1>

      <section class="card">
        <h2>{{ 'settings.profile' | transloco }}</h2>
        <form (ngSubmit)="saveName()" class="row">
          <mat-form-field appearance="outline"><mat-label>{{ 'auth.name' | transloco }}</mat-label><input matInput name="name" [(ngModel)]="displayName" maxlength="80" required /></mat-form-field>
          <button mat-flat-button type="submit" [disabled]="!displayName.trim() || displayName.trim() === auth.user()?.displayName">{{ 'common.save' | transloco }}</button>
        </form>
        <p class="muted">{{ auth.user()?.email }}
          @if (auth.user()?.emailVerified) { <span class="ok"><mat-icon>verified</mat-icon>{{ 'settings.verified' | transloco }}</span> }
          @else { <span class="warn"><mat-icon>warning</mat-icon>{{ 'settings.unverified' | transloco }}</span> }
        </p>
      </section>

      <section class="card">
        <h2>{{ 'settings.language' | transloco }}</h2>
        <mat-form-field appearance="outline">
          <mat-select [attr.aria-label]="'settings.language' | transloco" [value]="auth.user()?.locale ?? 'en'" (valueChange)="setLocale($event)">
            <mat-option value="en">English</mat-option>
            <mat-option value="pt">Português</mat-option>
          </mat-select>
        </mat-form-field>
      </section>

      <section class="card" id="privacy">
        <h2>{{ 'settings.privacy.title' | transloco }}</h2>
        <label class="toggle">
          <input type="checkbox" data-invisible [checked]="auth.user()?.presenceMode === 'invisible'" (change)="setInvisible($any($event.target).checked)" />
          <span>{{ 'settings.privacy.invisible' | transloco }}</span>
        </label>
        <p class="muted hint">{{ 'settings.privacy.invisibleHint' | transloco }}</p>
        <label class="toggle">
          {{ 'settings.privacy.dms' | transloco }}
          <select name="allowDMs" data-allow-dms [value]="auth.user()?.allowDMsFrom ?? 'members'" (change)="setAllowDms($any($event.target).value)" [attr.aria-label]="'settings.privacy.dms' | transloco">
            <option value="members">{{ 'settings.privacy.dmsMembers' | transloco }}</option>
            <option value="nobody">{{ 'settings.privacy.dmsNobody' | transloco }}</option>
          </select>
        </label>
        <app-blocked-users />
      </section>

      <section class="card" id="notifications">
        <h2>{{ 'settings.notifications' | transloco }}</h2>
        <app-notification-settings />
      </section>

      <section class="card" id="chat">
        <h2>{{ 'settings.chat.title' | transloco }}</h2>
        <label class="toggle">
          <input type="checkbox" data-send-ctrl [checked]="sendCtrl()" (change)="setSendCtrl($any($event.target).checked)" />
          <span>{{ 'settings.chat.sendWithCtrl' | transloco }}</span>
        </label>
        <p class="muted hint">{{ 'settings.chat.sendWithCtrlHint' | transloco }}</p>
      </section>

      <section class="card" id="appearance">
        <h2>{{ 'settings.appearance.title' | transloco }}</h2>
        <p class="muted hint">{{ 'settings.appearance.hint' | transloco }}</p>
        <div class="themes" role="radiogroup" [attr.aria-label]="'settings.appearance.title' | transloco" (keydown)="onThemeKey($event)">
          @for (id of themes; track id) {
            <button type="button" role="radio" class="theme" [class.on]="theme.choice() === id" [attr.aria-checked]="theme.choice() === id" [tabindex]="theme.choice() === id ? 0 : -1" [attr.data-pick]="id" (click)="pick(id)">
              <span class="mini" aria-hidden="true">
                @if (id === 'system') {
                  <span class="half" data-theme="light"><i class="top"></i><i class="ln"></i><i class="ln short"></i><i class="chip"></i></span>
                  <span class="half" data-theme="dark"><i class="top"></i><i class="ln"></i><i class="ln short"></i><i class="chip"></i></span>
                } @else {
                  <span class="half" [attr.data-theme]="id"><i class="top"></i><i class="ln"></i><i class="ln short"></i><i class="chip"></i></span>
                }
              </span>
              <span class="name">
                {{ 'theme.' + id | transloco }}
                @if (theme.choice() === id) { <mat-icon>check_circle</mat-icon> }
              </span>
            </button>
          }
        </div>
      </section>

      <section class="card" id="storage">
        <h2>{{ 'settings.storage' | transloco }}</h2>
        @if (quota.usage(); as u) {
          <div class="bar" [class.warn]="quota.level() === 'warn'" [class.full]="quota.level() === 'full'" role="meter" [attr.aria-valuenow]="u.used" aria-valuemin="0" [attr.aria-valuemax]="u.limit" [attr.aria-label]="'quota.title' | transloco">
            <div class="fill" [style.width.%]="quota.fraction() * 100"></div>
          </div>
          <p class="usage" data-usage>
            <strong data-used>{{ mb(u.used) }}</strong> {{ 'quota.of' | transloco }} <span data-limit>{{ mb(u.limit) }}</span> MB {{ 'quota.used' | transloco }}
          </p>
          <ul class="kinds">
            <li data-kind="images"><span class="dot images"></span>{{ 'quota.images' | transloco }}<span class="muted">{{ mb(u.images) }} MB</span></li>
            <li data-kind="video"><span class="dot video"></span>{{ 'quota.video' | transloco }}<span class="muted">{{ mb(u.video) }} MB</span></li>
            <li data-kind="documents"><span class="dot docs"></span>{{ 'quota.documents' | transloco }}<span class="muted">{{ mb(u.documents) }} MB</span></li>
          </ul>
          @if (quota.level() === 'full') {
            <p class="msg full" role="alert" data-quota-full><mat-icon>block</mat-icon>{{ 'quota.full' | transloco }}</p>
          } @else if (quota.level() === 'warn') {
            <p class="msg warn" role="status" data-quota-warning><mat-icon>warning</mat-icon>{{ 'quota.warning' | transloco }}</p>
          }
        }
      </section>

      <section class="card">
        <h2>{{ 'settings.password' | transloco }}</h2>
        <form (ngSubmit)="changePassword()">
          <mat-form-field appearance="outline"><mat-label>{{ 'settings.currentPassword' | transloco }}</mat-label><input matInput type="password" name="cur" [(ngModel)]="current" autocomplete="current-password" required /></mat-form-field>
          <mat-form-field appearance="outline"><mat-label>{{ 'settings.newPassword' | transloco }}</mat-label><input matInput type="password" name="new" [(ngModel)]="next" autocomplete="new-password" minlength="10" required /><mat-hint>{{ 'auth.passwordHint' | transloco }}</mat-hint></mat-form-field>
          @if (pwError()) { <p class="err">{{ pwError() | transloco }}</p> }
          <button mat-flat-button type="submit" [disabled]="!current || next.length < 10">{{ 'settings.changePassword' | transloco }}</button>
        </form>
      </section>

      <section class="card">
        <h2>{{ 'settings.sessions' | transloco }}</h2>
        <ul class="sessions">
          @for (s of sessions(); track s.id) {
            <li>
              <mat-icon>{{ s.current ? 'computer' : 'devices' }}</mat-icon>
              <div class="info"><strong>{{ device(s.userAgent) }}</strong><span class="muted">{{ s.ip }} · {{ lang.date(s.createdAt, 'long') }}</span></div>
              @if (s.current) { <span class="muted">{{ 'settings.thisDevice' | transloco }}</span> }
              @else { <button mat-button type="button" (click)="revoke(s)">{{ 'settings.signOutDevice' | transloco }}</button> }
            </li>
          }
        </ul>
      </section>

      <h2 class="apps-title">{{ 'nav.getApp' | transloco }}</h2>
      <app-apps-panel />
    </div>
  `,
  styles: `
    .wrap { max-width: 760px; margin: 0 auto; padding: 24px 20px 64px; display: flex; flex-direction: column; gap: 16px; } h1 { margin: 0; }
    .card { border: 1px solid var(--border); border-radius: 16px; padding: 20px 24px; } h2 { margin: 0 0 12px; font-size: 18px; } .apps-title { margin: 16px 0 0; }
    .toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; } .toggle input { width: 18px; height: 18px; accent-color: var(--accent); }
    .row { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; } form { display: flex; flex-direction: column; gap: 4px; } form.row { flex-direction: row; } mat-form-field { min-width: 220px; }
    .ok, .warn { display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; } .ok { color: #2f9e44; } .warn { color: #e8590c; } mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .bar { height: 10px; border-radius: 5px; background: var(--surface-3); overflow: hidden; } .fill { height: 100%; background: var(--accent); }
    .bar.warn .fill { background: #e8590c; } .bar.full .fill { background: var(--mat-sys-error); }
    .usage { margin: 8px 0 4px; } .kinds { list-style: none; padding: 0; margin: 4px 0 0; display: flex; flex-direction: column; gap: 4px; }
    .kinds li { display: flex; align-items: center; gap: 8px; } .kinds .muted { margin-left: auto; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--accent); } .dot.video { background: #e8590c; } .dot.docs { background: var(--text-dim); }
    .msg { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; } .msg.warn { color: #e8590c; } .msg.full { color: var(--mat-sys-error); }
    .err { color: var(--mat-sys-error); margin: 0; } .sessions { list-style: none; padding: 0; margin: 0; } .sessions li { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); }
    .info { flex: 1; display: flex; flex-direction: column; min-width: 0; } .info span { font-size: 13px; }
    .hint { margin: -4px 0 12px; font-size: 14px; }
    .themes { display: grid; grid-template-columns: repeat(auto-fill, minmax(132px, 1fr)); gap: 12px; }
    .theme { display: flex; flex-direction: column; gap: 8px; padding: 8px; border: 2px solid var(--border); border-radius: 14px; background: none; color: var(--text); cursor: pointer; text-align: left; }
    .theme:hover { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
    .theme:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
    .theme.on { border-color: var(--accent); }
    .name { display: flex; align-items: center; justify-content: space-between; gap: 4px; font-size: 14px; padding: 0 2px 2px; } .name mat-icon { color: var(--accent); margin: 0; }
    /* each half takes the colours of the theme named on it (tokens from themes.scss), whatever theme the page is in */
    .mini { display: flex; height: 76px; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
    .half { flex: 1; display: flex; flex-direction: column; gap: 5px; padding: 8px; background: var(--mat-sys-surface); }
    .half i { display: block; border-radius: 3px; height: 6px; background: var(--mat-sys-on-surface-variant); opacity: 0.7; }
    .half i.top { height: 8px; width: 45%; background: var(--mat-sys-primary); opacity: 1; }
    .half i.short { width: 60%; }
    .half i.chip { height: 12px; width: 34px; margin-top: auto; background: var(--mat-sys-primary-container); opacity: 1; border-radius: 6px; }
  `,
})
export class SettingsPage implements OnInit {
  readonly auth = inject(AuthStore);
  readonly lang = inject(Language);
  readonly theme = inject(ThemeService);
  readonly quota = inject(QuotaStore);
  readonly themes = THEMES;
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);

  displayName = this.auth.user()?.displayName ?? '';
  current = '';
  next = '';
  readonly pwError = signal('');
  readonly sessions = signal<SessionDto[]>([]);

  ngOnInit(): void {
    void this.loadSessions();
    void this.quota.refresh();
  }

  mb(bytes: number): string {
    const mb = bytes / 1024 / 1024;
    return mb < 10 ? mb.toFixed(2) : mb.toFixed(1); // small amounts need the extra digit to show movement
  }

  /** "Chrome on Windows" from a user-agent string; good enough to tell devices apart. */
  device(ua: string | null): string {
    if (!ua) return '—';
    const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Electron\//.test(ua) ? 'Desktop app' : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${browser} · ${os}` : browser;
  }

  async saveName(): Promise<void> {
    await this.auth.updateProfile({ displayName: this.displayName.trim() });
    this.notify.info('settings.saved');
  }

  readonly sendCtrl = sendWithCtrl;

  setSendCtrl(on: boolean): void {
    setSendWithCtrl(on);
  }

  async setAllowDms(value: 'members' | 'nobody'): Promise<void> {
    await this.auth.updateProfile({ allowDMsFrom: value });
  }

  async setInvisible(on: boolean): Promise<void> {
    await this.auth.updateProfile({ presenceMode: on ? 'invisible' : 'auto' });
  }

  async setLocale(locale: Locale): Promise<void> {
    this.lang.set(locale);
    await this.auth.updateProfile({ locale });
  }

  pick(id: Theme): void {
    void this.theme.choose(id);
  }

  /** Arrow keys move through the themes like a radio group; the focused one is also the chosen one. */
  onThemeKey(event: KeyboardEvent): void {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = this.themes[(this.themes.indexOf(this.theme.choice()) + step + this.themes.length) % this.themes.length]!;
    this.pick(next);
    queueMicrotask(() => (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-pick="${next}"]`)?.focus());
  }

  async changePassword(): Promise<void> {
    this.pwError.set('');
    try {
      await firstValueFrom(this.http.post('/api/me/password', { currentPassword: this.current, newPassword: this.next }));
      this.current = this.next = '';
      this.notify.info('settings.passwordChanged');
      await this.loadSessions();
    } catch (e) {
      const code = toProblem(e).code;
      this.pwError.set(['invalid_credentials', 'password_too_common', 'offline'].includes(code) ? `errors.${code}` : 'errors.generic');
    }
  }

  async revoke(s: SessionDto): Promise<void> {
    await firstValueFrom(this.http.delete(`/api/me/sessions/${s.id}`));
    await this.loadSessions();
  }

  private async loadSessions(): Promise<void> {
    try {
      this.sessions.set(await firstValueFrom(this.http.get<SessionDto[]>('/api/me/sessions')));
    } catch {
      /* offline: the list stays as it was */
    }
  }
}
