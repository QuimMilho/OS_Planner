import { Component, computed, effect, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { type LocalHistoryRow } from '../../data/db';
import { HistoryError, HistoryStore } from '../../data/history-store';

interface Group {
  day: string;
  spaces: { spaceId: string; name: string; entries: LocalHistoryRow[] }[];
}

const ICONS = { notebook: 'book', category: 'folder', page: 'description', task: 'task_alt', event: 'event' } as const;
const REASONS = { conflict: 'conflict', target_deleted: 'targetDeleted', forbidden: 'forbidden', quota: 'quota', pre_merge: 'preMerge' } as const;
const ISO = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/;

/** The Local history: what this device changed offline that did not make it online as it was, with what to do about each. */
@Component({
  selector: 'app-history-page',
  imports: [MatButtonModule, MatIconModule, RouterLink, TranslocoPipe],
  template: `
    <div class="wrap" data-history>
      <h1>{{ 'history.title' | transloco }}</h1>
      <p class="muted">{{ 'history.info' | transloco }}</p>

      <div class="bar">
        @if (entityId(); as id) {
          <span class="filter" data-history-filter>{{ 'history.only' | transloco: { name: filterName() } }}</span>
          <a mat-button routerLink="/app/history">{{ 'history.showAll' | transloco }}</a>
        }
        <label class="toggle"><input type="checkbox" [checked]="showResolved()" (change)="showResolved.set($any($event.target).checked)" />{{ 'history.showResolved' | transloco }}</label>
        <span class="grow"></span>
        @if (waiting().length > 1) {
          <button mat-stroked-button type="button" data-bulk="replace" [disabled]="busy()" (click)="bulk('replace')">{{ 'history.replaceAll' | transloco }}</button>
          <button mat-stroked-button type="button" data-bulk="add" [disabled]="busy()" (click)="bulk('add')">{{ 'history.addAllAsNew' | transloco }}</button>
          <button mat-stroked-button type="button" data-bulk="dismiss" [disabled]="busy()" (click)="bulk('dismiss')">{{ 'history.dismissAll' | transloco }}</button>
        }
      </div>

      @for (g of groups(); track g.day) {
        <h2 class="day">{{ g.day }}</h2>
        @for (s of g.spaces; track s.spaceId) {
          <h3 class="space">{{ s.name }}</h3>
          @for (e of s.entries; track e.id) {
            <article class="entry" [class.settled]="e.resolved !== 'none'" data-entry [attr.data-entity]="e.entity" [attr.data-entity-id]="e.entityId" [attr.data-reason]="e.reason" [attr.data-resolved]="e.resolved">
              <header>
                <mat-icon>{{ icon(e) }}</mat-icon>
                <div class="what">
                  <strong>
                    @if (link(e); as l) { <a [routerLink]="l" [attr.data-open]="e.entityId">{{ title(e) }}</a> } @else { {{ title(e) }} }
                  </strong>
                  <span class="muted">{{ 'history.entities.' + e.entity | transloco }} · {{ 'history.reasons.' + reason(e) | transloco }} · {{ time(e) }}@if (e.device) { · {{ 'history.device' | transloco: { device: e.device } }} }</span>
                </div>
                @if (e.resolved !== 'none') { <span class="state">{{ 'history.resolved.' + e.resolved | transloco }}</span> }
              </header>

              @if (e.state) {
                <p class="note">{{ 'history.pageMerge' | transloco }}</p>
              } @else if (isDelete(e)) {
                <p class="note">{{ (e.op.endsWith('.cancel') ? 'history.cancelRefused' : 'history.deleteRefused') | transloco }}</p>
              } @else if (fields(e).length) {
                <table>
                  <thead><tr><th></th><th>{{ 'history.yours' | transloco }}</th><th>{{ 'history.online' | transloco }}</th></tr></thead>
                  <tbody>
                    @for (f of fields(e); track f.name) {
                      <tr [attr.data-field]="f.name">
                        <th scope="row">{{ 'history.fields.' + f.name | transloco }}</th>
                        <td class="mine">{{ f.mine }}</td>
                        <td class="theirs">{{ f.server }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else if (e.reason === 'target_deleted') {
                <p class="note">{{ 'history.gone' | transloco }}</p>
              }

              @if (e.resolved === 'none') {
                <footer>
                  @if (canReplace(e)) {
                    <button mat-flat-button type="button" data-act="replace" [disabled]="busy()" [title]="'history.replaceHint' | transloco" (click)="replace(e)">{{ 'history.replace' | transloco }}</button>
                  }
                  @if (!isDelete(e)) {
                    <button mat-stroked-button type="button" data-act="add" [disabled]="busy()" [title]="'history.addAsNewHint' | transloco" (click)="addAsNew(e)">{{ 'history.addAsNew' | transloco }}</button>
                  }
                  <button mat-button type="button" data-act="dismiss" [disabled]="busy()" (click)="dismiss(e)">{{ 'history.dismiss' | transloco }}</button>
                </footer>
              }
            </article>
          }
        }
      } @empty {
        <p class="muted empty"><mat-icon>history</mat-icon>{{ 'history.empty' | transloco }}</p>
      }
    </div>
  `,
  styles: `
    .wrap { max-width: 820px; margin: 0 auto; padding: 24px 20px 64px; } h1 { margin: 0 0 4px; }
    .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 0; } .grow { flex: 1; } .toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; cursor: pointer; }
    .filter { padding: 4px 10px; border-radius: 12px; background: var(--surface-3); font-size: 14px; }
    .day { margin: 24px 0 0; font-size: 16px; } .space { margin: 8px 0 8px; font-size: 14px; font-weight: 500; color: var(--text-dim); }
    .entry { border: 1px solid var(--border); border-radius: 14px; padding: 12px 16px; margin: 0 0 10px; } .entry.settled { opacity: 0.65; }
    header { display: flex; align-items: center; gap: 12px; } header mat-icon { color: var(--text-dim); } .what { flex: 1; min-width: 0; display: flex; flex-direction: column; } .what span { font-size: 13px; }
    .state { font-size: 13px; padding: 2px 10px; border-radius: 12px; background: var(--surface-3); }
    .note { margin: 10px 0 0; color: var(--text-dim); }
    table { width: 100%; border-collapse: collapse; margin: 10px 0 0; font-size: 14px; } th, td { text-align: left; padding: 6px 8px; border-top: 1px solid var(--border); vertical-align: top; overflow-wrap: anywhere; }
    thead th { border-top: 0; font-weight: 500; color: var(--text-dim); font-size: 13px; } tbody th { font-weight: 500; width: 22%; } td.mine { background: color-mix(in srgb, var(--accent) 10%, transparent); }
    footer { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .empty { display: flex; justify-content: center; align-items: center; gap: 8px; padding: 40px 0; }
  `,
})
export class HistoryPage {
  readonly store = inject(HistoryStore);
  private readonly lang = inject(Language);
  private readonly notify = inject(Notify);
  private readonly route = inject(ActivatedRoute);

  readonly showResolved = signal(false);
  readonly busy = signal(false);
  /** Which of the things the entries are about still exist (Replace only makes sense for those). */
  private readonly alive = signal<Record<string, boolean>>({});

  private readonly query = toSignal(this.route.queryParamMap, { initialValue: this.route.snapshot.queryParamMap });
  readonly entityId = computed(() => this.query().get('entity'));
  readonly filterName = computed(() => this.store.entries().find((e) => e.entityId === this.entityId())?.entityTitle || this.lang.t('page.untitled'));

  readonly shown = computed(() =>
    this.store
      .entries()
      .filter((e) => (this.showResolved() || e.resolved === 'none') && (!this.entityId() || e.entityId === this.entityId())),
  );
  readonly waiting = computed(() => this.shown().filter((e) => e.resolved === 'none'));

  readonly groups = computed<Group[]>(() => {
    const days = new Map<string, Map<string, LocalHistoryRow[]>>();
    for (const e of this.shown()) {
      const day = this.lang.date(new Date(e.at));
      const spaces = days.get(day) ?? new Map<string, LocalHistoryRow[]>();
      spaces.set(e.spaceId, [...(spaces.get(e.spaceId) ?? []), e]);
      days.set(day, spaces);
    }
    return [...days].map(([day, spaces]) => ({ day, spaces: [...spaces].map(([spaceId, entries]) => ({ spaceId, name: this.store.spaceName(spaceId), entries })) }));
  });

  constructor() {
    effect(() => {
      const entries = this.store.entries();
      void (async () => {
        const out: Record<string, boolean> = {};
        for (const e of entries) out[e.id] = await this.store.exists(e);
        this.alive.set(out);
      })();
    });
  }

  icon(e: LocalHistoryRow): string {
    return ICONS[e.entity];
  }
  title(e: LocalHistoryRow): string {
    return e.entityTitle || this.lang.t('page.untitled');
  }
  reason(e: LocalHistoryRow): string {
    return REASONS[e.reason];
  }
  time(e: LocalHistoryRow): string {
    return new Intl.DateTimeFormat(this.lang.current === 'pt' ? 'pt-PT' : 'en-GB', { timeStyle: 'short' }).format(new Date(e.at));
  }
  isDelete(e: LocalHistoryRow): boolean {
    return /\.(delete|cancel)$/.test(e.op);
  }

  /** The place in the app where the live item is, when it still exists. */
  link(e: LocalHistoryRow): string[] | null {
    if (!this.alive()[e.id]) return null;
    if (e.entity === 'task') return ['/app/task', e.entityId];
    if (e.entity === 'page') return ['/app/p', e.entityId];
    if (e.entity === 'event') return ['/app/calendar'];
    return null;
  }

  canReplace(e: LocalHistoryRow): boolean {
    return !!this.alive()[e.id] && e.reason !== 'target_deleted';
  }

  /** One row per field: what this device wanted and what is online. */
  fields(e: LocalHistoryRow): { name: string; mine: string; server: string }[] {
    return Object.entries(e.fieldsRejected).map(([name, v]) => ({ name, mine: this.fmt(v.mine), server: this.fmt(v.server) }));
  }

  fmt(v: unknown): string {
    if (v === null || v === undefined || v === '') return this.lang.t('history.none');
    if (typeof v === 'boolean') return this.lang.t(v ? 'history.yes' : 'history.no');
    if (typeof v === 'string') return ISO.test(v) ? this.lang.date(v, 'long') : v.length > 160 ? `${v.slice(0, 160)}…` : v;
    if (Array.isArray(v)) return v.every((x) => typeof x === 'string' && !ISO.test(x)) && v.length <= 1 ? v.join(', ') || this.lang.t('history.none') : this.lang.t('history.items', { n: v.length });
    if (typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${this.fmt(x)}`).join(' · ');
    return String(v);
  }

  async replace(e: LocalHistoryRow): Promise<void> {
    await this.run(async () => {
      await this.store.replace(e);
      this.notify.info('history.replaced');
    });
  }

  async addAsNew(e: LocalHistoryRow): Promise<void> {
    await this.run(async () => {
      await this.store.addAsNew(e);
      this.notify.info('history.added');
    });
  }

  async dismiss(e: LocalHistoryRow): Promise<void> {
    await this.store.dismiss(e);
  }

  async bulk(kind: 'replace' | 'add' | 'dismiss'): Promise<void> {
    await this.run(async () => {
      for (const e of this.waiting()) {
        try {
          if (kind === 'dismiss') await this.store.dismiss(e);
          else if (kind === 'add') {
            if (!this.isDelete(e)) await this.store.addAsNew(e);
          } else if (this.canReplace(e)) await this.store.replace(e);
        } catch (err) {
          if (!(err instanceof HistoryError)) throw err;
        }
      }
    });
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    try {
      await work();
    } catch (err) {
      if (err instanceof HistoryError) this.notify.error(err.code === 'gone' ? 'history.failedGone' : err.code === 'offline' ? 'history.failedOffline' : 'history.failedNothing');
      else throw err;
    } finally {
      this.busy.set(false);
    }
  }
}
