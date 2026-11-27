import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { AuthStore } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { Dialogs } from '../../shared/dialogs';
import { HISTORY_DAYS_MAX, HistoryStore } from '../../data/history-store';
import { OfflineScope } from '../../data/offline-scope';
import { TeamStore } from '../../data/team-store';

/** Settings -> Offline: how long the Local history is kept, what it takes, and which spaces keep their page texts on this device. */
@Component({
  selector: 'app-offline-settings',
  imports: [MatButtonModule, RouterLink, TranslocoPipe],
  template: `
    <p class="muted hint">{{ 'offline.settings.hint' | transloco }}</p>

    <div class="row">
      <label for="history-days">{{ 'offline.settings.retention' | transloco }}</label>
      <input id="history-days" type="number" min="1" [max]="max" name="days" data-history-days [value]="store.days()" (change)="days($any($event.target).valueAsNumber)" />
      <span>{{ 'offline.settings.days' | transloco }}</span>
    </div>
    <p class="muted hint">{{ 'offline.settings.retentionHint' | transloco }}</p>

    <p data-history-used>{{ 'offline.settings.used' | transloco: { n: store.entries().length, size: mb(store.bytes()) } }}
      <a routerLink="/app/history">{{ 'history.openHistory' | transloco }}</a>
    </p>
    <button mat-stroked-button type="button" data-history-clear [disabled]="!store.entries().length" (click)="clear()">{{ 'offline.settings.clear' | transloco }}</button>

    <h3>{{ 'offline.settings.scope' | transloco }}</h3>
    <p class="muted hint">{{ 'offline.settings.scopeHint' | transloco }}</p>
    <ul class="spaces">
      @for (s of spaces(); track s.id) {
        <li><label><input type="checkbox" [attr.data-scope]="s.id" [checked]="!scope.excluded().includes(s.id)" (change)="scope.keep(s.id, $any($event.target).checked)" />{{ s.name }}</label></li>
      }
    </ul>
    @if (estimate(); as e) {
      <p class="muted" data-offline-storage>{{ 'offline.settings.storage' | transloco: { used: mb(e.usage), quota: mb(e.quota) } }}</p>
      @if (e.usage > 500 * 1024 * 1024 || e.usage > e.quota * 0.8) { <p class="warn" role="status">{{ 'offline.settings.storageWarn' | transloco }}</p> }
    }
  `,
  styles: `
    .row { display: flex; align-items: center; gap: 8px; margin: 8px 0 0; } input[type='number'] { width: 76px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: inherit; }
    .hint { margin: 4px 0 12px; font-size: 14px; } h3 { margin: 20px 0 4px; font-size: 16px; } .spaces { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 6px; }
    .spaces label { display: flex; align-items: center; gap: 8px; cursor: pointer; } .spaces input { width: 18px; height: 18px; accent-color: var(--accent); } .warn { color: #e8590c; }
  `,
})
export class OfflineSettings implements OnInit {
  readonly store = inject(HistoryStore);
  readonly scope = inject(OfflineScope);
  private readonly teams = inject(TeamStore);
  private readonly auth = inject(AuthStore);
  private readonly notify = inject(Notify);
  private readonly dialogs = inject(Dialogs);
  private readonly lang = inject(Language);
  readonly max = HISTORY_DAYS_MAX;

  readonly estimate = signal<{ usage: number; quota: number } | null>(null);

  readonly spaces = computed(() => {
    const personal = this.auth.user()?.personalSpaceId;
    return [
      ...(personal ? [{ id: personal, name: this.lang.t('offline.settings.personal') }] : []),
      ...(this.teams.teams() ?? []).map((t) => ({ id: t.spaceId, name: t.name })),
      ...this.teams.projects().map((p) => ({ id: p.spaceId, name: this.store.spaceName(p.spaceId) })),
    ];
  });

  ngOnInit(): void {
    void this.store.load();
    void navigator.storage?.estimate?.().then((e) => this.estimate.set({ usage: e.usage ?? 0, quota: e.quota ?? 0 }));
  }

  mb(bytes: number): string {
    const n = bytes / 1024 / 1024;
    return n < 10 ? n.toFixed(2) : n.toFixed(0);
  }

  /** Taken when the field is left, not on every key: typing 30 must not first apply 3. */
  days(value: number): void {
    if (Number.isFinite(value)) void this.store.setDays(value);
  }

  async clear(): Promise<void> {
    if (!(await this.dialogs.confirm({ titleKey: 'offline.settings.clear', messageKey: 'offline.settings.confirmClear', confirmKey: 'offline.settings.clear', danger: true }))) return;
    await this.store.clear();
    this.notify.info('offline.settings.cleared');
  }
}
