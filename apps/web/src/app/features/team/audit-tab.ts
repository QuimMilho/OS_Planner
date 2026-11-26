import { DatePipe, JsonPipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { AUDIT_ACTIONS } from '@os-planner/shared/lite';
import type { AuditEntryDto } from '@os-planner/shared';
import type { ApiProblem } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { RolesStore } from '../../data/roles-store';
import { TeamStore } from '../../data/team-store';
import { roleErrorKey } from './roles-editor';

/** The team's audit log: who changed what and when, with filters, a before/after view of each change and paging. */
@Component({
  selector: 'app-audit-tab',
  imports: [DatePipe, JsonPipe, FormsModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <div data-audit-tab>
      <form class="filters" (ngSubmit)="apply()">
        <label>
          <span>{{ 'audit.actionLabel' | transloco }}</span>
          <select name="audit-action" [ngModel]="action()" (ngModelChange)="action.set($event)">
            <option value="">{{ 'audit.any' | transloco }}</option>
            @for (a of actions; track a) {
              <option [value]="a">{{ actionKey(a) | transloco }}</option>
            }
          </select>
        </label>
        <label>
          <span>{{ 'audit.actor' | transloco }}</span>
          <select name="audit-actor" [ngModel]="actor()" (ngModelChange)="actor.set($event)">
            <option value="">{{ 'audit.any' | transloco }}</option>
            @for (m of members(); track m.userId) {
              <option [value]="m.userId">{{ m.nickname || m.displayName }}</option>
            }
          </select>
        </label>
        <label>
          <span>{{ 'audit.from' | transloco }}</span>
          <input
            type="date"
            name="audit-from"
            [ngModel]="from()"
            (ngModelChange)="from.set($event)"
          />
        </label>
        <label>
          <span>{{ 'audit.to' | transloco }}</span>
          <input type="date" name="audit-to" [ngModel]="to()" (ngModelChange)="to.set($event)" />
        </label>
        <button mat-stroked-button type="submit" data-action="audit-apply">
          {{ 'audit.apply' | transloco }}
        </button>
      </form>

      <ul class="entries" data-audit-list>
        @for (e of entries(); track e.id) {
          <li [attr.data-audit]="e.action" [class.open]="isOpen(e.id)">
            <button
              type="button"
              class="summary"
              (click)="toggle(e.id)"
              [attr.aria-expanded]="isOpen(e.id)"
            >
              <mat-icon aria-hidden="true">{{
                isOpen(e.id) ? 'expand_more' : 'chevron_right'
              }}</mat-icon>
              <span class="what">{{ actionKey(e.action) | transloco }}</span>
              <span class="detail">{{ detail(e) }}</span>
              <span class="who" data-audit-actor>{{
                e.actorName ?? ('audit.system' | transloco)
              }}</span>
              <time class="when" [attr.datetime]="e.createdAt">{{
                e.createdAt | date: 'medium'
              }}</time>
            </button>
            @if (isOpen(e.id)) {
              <div class="diff" data-audit-diff>
                <div>
                  <h4>{{ 'audit.before' | transloco }}</h4>
                  <pre>{{ e.before === null ? '—' : (e.before | json) }}</pre>
                </div>
                <div>
                  <h4>{{ 'audit.after' | transloco }}</h4>
                  <pre>{{ e.after === null ? '—' : (e.after | json) }}</pre>
                </div>
              </div>
            }
          </li>
        } @empty {
          @if (!loading()) {
            <li class="muted empty">{{ 'audit.empty' | transloco }}</li>
          }
        }
      </ul>

      @if (cursor()) {
        <button
          mat-stroked-button
          type="button"
          (click)="more()"
          [disabled]="loading()"
          data-action="audit-more"
        >
          {{ 'audit.more' | transloco }}
        </button>
      }
    </div>
  `,
  styles: `
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: flex-end;
      margin-bottom: 16px;
    }
    .filters label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 12px;
      color: var(--text-dim);
    }
    select,
    input {
      height: 36px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-2);
      color: var(--text);
      padding: 0 8px;
      font: inherit;
    }
    .entries {
      list-style: none;
      margin: 0 0 16px;
      padding: 0;
    }
    .entries li {
      border-bottom: 1px solid var(--border);
    }
    .summary {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      text-align: left;
      padding: 8px 4px;
      border: 0;
      background: none;
      color: var(--text);
      font: inherit;
      cursor: pointer;
      flex-wrap: wrap;
    }
    .summary:hover {
      background: var(--surface-3);
    }
    .what {
      font-weight: 600;
    }
    .detail {
      flex: 1;
      min-width: 100px;
      color: var(--text-dim);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .who,
    .when {
      font-size: 13px;
      color: var(--text-dim);
    }
    .diff {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      padding: 4px 8px 12px 34px;
    }
    @media (max-width: 640px) {
      .diff {
        grid-template-columns: 1fr;
      }
    }
    h4 {
      margin: 0 0 4px;
      font-size: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
    }
    pre {
      margin: 0;
      padding: 8px;
      border-radius: 8px;
      background: var(--surface-2);
      font-size: 12px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .empty {
      padding: 16px 4px;
    }
  `,
})
export class AuditTab {
  readonly teamId = input.required<string>();

  private readonly store = inject(RolesStore);
  private readonly teams = inject(TeamStore);
  private readonly notify = inject(Notify);
  private readonly lang = inject(Language);

  protected readonly actions = AUDIT_ACTIONS;
  protected readonly action = signal('');
  protected readonly actor = signal('');
  protected readonly from = signal('');
  protected readonly to = signal('');

  protected readonly entries = signal<AuditEntryDto[]>([]);
  protected readonly cursor = signal<string | null>(null);
  protected readonly loading = signal(false);
  private readonly opened = signal(new Set<string>());
  protected readonly members = computed(() => this.teams.membersOf(this.teamId()));

  constructor() {
    effect(() => {
      this.teamId();
      untracked(() => void this.apply());
    });
  }

  /** Starts again from the newest entry with the filters as they are. */
  protected async apply(): Promise<void> {
    this.entries.set([]);
    this.cursor.set(null);
    await this.fetch(undefined);
  }

  protected more(): Promise<void> {
    return this.fetch(this.cursor() ?? undefined);
  }

  private async fetch(cursor: string | undefined): Promise<void> {
    this.loading.set(true);
    try {
      const day = (v: string, end: boolean) =>
        v ? new Date(`${v}T${end ? '23:59:59.999' : '00:00:00.000'}`).toISOString() : undefined;
      const page = await this.store.audit(this.teamId(), {
        action: this.action() || undefined,
        actor: this.actor() || undefined,
        from: day(this.from(), false),
        to: day(this.to(), true),
        cursor,
        limit: 50,
      });
      this.entries.update((list) => [...list, ...page.items]);
      this.cursor.set(page.nextCursor);
    } catch (e) {
      this.notify.error(roleErrorKey(e as ApiProblem));
    } finally {
      this.loading.set(false);
    }
  }

  /** `role.create` -> `audit.action.role_create` (a dot would be read as another level of the translation file). */
  protected actionKey(action: string): string {
    return `audit.action.${action.replaceAll('.', '_')}`;
  }

  protected isOpen(id: string): boolean {
    return this.opened().has(id);
  }

  protected toggle(id: string): void {
    this.opened.update((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** A short line saying what the entry is about, from what was recorded. */
  protected detail(e: AuditEntryDto): string {
    const side = (e.after ?? e.before) as Record<string, unknown> | null;
    const pick = (k: string) => (side && typeof side[k] === 'string' ? (side[k] as string) : null);
    const name = pick('name') ?? pick('roleName') ?? pick('subjectName') ?? pick('projectName');
    if (name) return name;
    if (e.targetKind === 'member') {
      const m = this.members().find((x) => x.userId === e.targetId);
      return m ? m.nickname || m.displayName : '';
    }
    return this.lang.t(`audit.target.${e.targetKind}`) === `audit.target.${e.targetKind}`
      ? ''
      : this.lang.t(`audit.target.${e.targetKind}`);
  }
}
