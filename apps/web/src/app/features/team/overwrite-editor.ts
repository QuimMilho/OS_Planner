import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  ALL_PERMISSIONS,
  permissionsFromString,
  permissionsToString,
} from '@os-planner/shared/lite';
import type { OverwriteDto, RoleDto } from '@os-planner/shared';
import type { ApiProblem } from '../../core/auth-store';
import { AppUpdates } from '../../core/app-updates';
import { Notify } from '../../core/notify';
import { RolesStore } from '../../data/roles-store';
import { TeamStore } from '../../data/team-store';
import { PermissionGrid, type GridValue } from './permission-grid';
import { roleErrorKey } from './roles-editor';

interface Subject {
  key: string;
  kind: 'role' | 'member';
  id: string;
  name: string;
  color: string | null;
}

const bitCount = (n: bigint): number => n.toString(2).replaceAll('0', '').length;

/**
 * The allow/deny overwrites of one project, per role and per member, edited with the tri-state control (allow ✓,
 * inherit –, deny ✗). A subject without an overwrite here is "synced with the parent": it gets what the levels above
 * give it. "Reset to inherited" removes the overwrite.
 */
@Component({
  selector: 'app-overwrite-editor',
  imports: [FormsModule, MatButtonModule, MatIconModule, TranslocoPipe, PermissionGrid],
  template: `
    <div class="ow" data-overwrite-editor>
      <aside>
        <h3>{{ 'overwrite.subjects' | transloco }}</h3>
        <div class="list">
          @for (s of subjects(); track s.key) {
            <button
              type="button"
              class="subj"
              [class.on]="s.key === selectedKey()"
              [attr.data-subject]="s.name"
              (click)="selectedKey.set(s.key)"
            >
              <span class="dot" [style.background]="s.color ?? 'var(--text-dim)'"></span>
              <span class="name">{{ s.name }}</span>
              @if (rowOf(s); as o) {
                <span
                  class="badge"
                  [attr.data-has-overwrite]="s.name"
                  [attr.title]="'overwrite.custom' | transloco"
                  >{{ summary(o) }}</span
                >
              }
            </button>
          }
        </div>
        @if (addable().length) {
          <label class="add">
            <span>{{ 'overwrite.addMember' | transloco }}</span>
            <select name="overwrite-add-member" [ngModel]="''" (ngModelChange)="addMember($event)">
              <option value="">{{ 'overwrite.pickMember' | transloco }}</option>
              @for (m of addable(); track m.userId) {
                <option [value]="m.userId">{{ m.nickname || m.displayName }}</option>
              }
            </select>
          </label>
        }
      </aside>

      <section>
        @if (selected(); as s) {
          <div class="state" data-overwrite-state [attr.data-synced]="!currentRow()">
            @if (currentRow()) {
              <mat-icon aria-hidden="true">tune</mat-icon>{{ 'overwrite.custom' | transloco }}
            } @else {
              <mat-icon aria-hidden="true">sync</mat-icon
              >{{ 'overwrite.syncedWithParent' | transloco }}
            }
          </div>
          <app-permission-grid
            mode="tri"
            [allow]="draft().allow"
            [deny]="draft().deny"
            [editable]="editable()"
            (changed)="draft.set($event)"
          />
          <div class="actions">
            <button
              mat-flat-button
              type="button"
              (click)="save(s)"
              [disabled]="!dirty() || saving()"
              [attr.data-dirty]="dirty()"
              data-action="save-overwrite"
            >
              {{ 'common.save' | transloco }}
            </button>
            <button
              mat-stroked-button
              type="button"
              (click)="reset(s)"
              [disabled]="!currentRow() || saving()"
              data-action="reset-overwrite"
            >
              <mat-icon>undo</mat-icon>{{ 'overwrite.reset' | transloco }}
            </button>
          </div>
        } @else {
          <p class="muted">{{ 'overwrite.pick' | transloco }}</p>
        }
      </section>
    </div>
  `,
  styles: `
    .ow {
      display: grid;
      grid-template-columns: minmax(200px, 260px) minmax(0, 1fr);
      gap: 24px;
      align-items: start;
    }
    @media (max-width: 760px) {
      .ow {
        grid-template-columns: 1fr;
      }
    }
    h3 {
      margin: 0 0 8px;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .subj {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 8px;
      border: 1px solid transparent;
      background: none;
      color: var(--text);
      font: inherit;
      cursor: pointer;
      text-align: left;
    }
    .subj:hover {
      background: var(--surface-3);
    }
    .subj.on {
      background: var(--surface-3);
      border-color: var(--border);
      font-weight: 600;
    }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex: none;
    }
    .name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badge {
      font-size: 12px;
      color: var(--text-dim);
    }
    .add {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 12px;
      font-size: 12px;
      color: var(--text-dim);
    }
    select {
      height: 36px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-2);
      color: var(--text);
      padding: 0 8px;
      font: inherit;
    }
    .state {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 8px;
      background: var(--surface-3);
      color: var(--text-dim);
      margin-bottom: 8px;
    }
    .actions {
      display: flex;
      gap: 10px;
      margin-top: 16px;
    }
  `,
})
export class OverwriteEditor {
  /** What the overwrites are set on: a project (the default), a channel or a notebook; `projectId` is that target's id. */
  readonly kind = input<'project' | 'channel' | 'notebook'>('project');
  readonly projectId = input.required<string>();
  /** For a channel: what the person holds in it (decimal string); you can only allow or deny what you hold. */
  readonly held = input<string | null>(null);
  readonly teamId = input.required<string>();
  /** The roles that can be the subject here: team roles, @everyone and the roles of this project and above. */
  readonly roles = input.required<readonly RoleDto[]>();

  private readonly store = inject(RolesStore);
  private readonly teams = inject(TeamStore);
  private readonly notify = inject(Notify);

  protected readonly rows = signal<OverwriteDto[]>([]);
  protected readonly selectedKey = signal<string | null>(null);
  protected readonly draft = signal<GridValue>({ allow: 0n, deny: 0n });
  protected readonly saving = signal(false);
  /** Members added to the list to give them an overwrite, before one exists. */
  private readonly extraMembers = signal<string[]>([]);

  private readonly members = computed(() => this.teams.membersOf(this.teamId()));

  protected readonly subjects = computed<Subject[]>(() => {
    const roles = [...this.roles()].sort((a, b) =>
      a.isEveryone ? 1 : b.isEveryone ? -1 : b.position - a.position,
    );
    const out: Subject[] = roles.map((r) => ({
      key: `role:${r.id}`,
      kind: 'role',
      id: r.id,
      name: r.name,
      color: r.color,
    }));
    const memberIds = new Set([
      ...this.rows()
        .filter((o) => o.subjectKind === 'member')
        .map((o) => o.subjectId),
      ...this.extraMembers(),
    ]);
    for (const m of this.members())
      if (memberIds.has(m.userId))
        out.push({
          key: `member:${m.userId}`,
          kind: 'member',
          id: m.userId,
          name: m.nickname || m.displayName,
          color: null,
        });
    return out;
  });

  protected readonly addable = computed(() => {
    const shown = new Set(
      this.subjects()
        .filter((s) => s.kind === 'member')
        .map((s) => s.id),
    );
    return this.members().filter((m) => !shown.has(m.userId));
  });

  protected readonly selected = computed(
    () => this.subjects().find((s) => s.key === this.selectedKey()) ?? null,
  );
  protected readonly currentRow = computed(() => {
    const s = this.selected();
    return s ? this.rowOf(s) : null;
  });
  /** You can only allow or deny what you hold yourself in this project. */
  protected readonly editable = computed(() => {
    const raw = this.kind() !== 'project' ? this.held() : this.teams.permissionsOf(this.teamId(), this.projectId());
    return raw === null ? 0n : (permissionsFromString(raw) ?? ALL_PERMISSIONS);
  });
  protected readonly dirty = computed(() => {
    const row = this.currentRow();
    const d = this.draft();
    return d.allow !== (row ? bits(row.allow) : 0n) || d.deny !== (row ? bits(row.deny) : 0n);
  });

  constructor() {
    inject(AppUpdates).holdWhile(this.dirty); // an update's reload would throw the unsaved changes away
    effect(() => {
      const id = this.projectId();
      untracked(() => {
        this.extraMembers.set([]);
        void this.load(id);
      });
    });
    effect(() => {
      const row = this.currentRow();
      untracked(() =>
        this.draft.set({ allow: row ? bits(row.allow) : 0n, deny: row ? bits(row.deny) : 0n }),
      );
    });
    effect(() => {
      // keep a valid selection: @everyone first
      const subjects = this.subjects();
      if (!subjects.some((s) => s.key === untracked(this.selectedKey)))
        untracked(() =>
          this.selectedKey.set(
            subjects.find((s) => this.roles().find((r) => r.id === s.id)?.isEveryone)?.key ??
              subjects[0]?.key ??
              null,
          ),
        );
    });
  }

  private async load(projectId: string): Promise<void> {
    try {
      this.rows.set(await this.store.overwrites(projectId, this.kind()));
    } catch (e) {
      this.notify.error(roleErrorKey(e as ApiProblem));
    }
  }

  protected rowOf(s: Subject): OverwriteDto | null {
    return this.rows().find((o) => o.subjectKind === s.kind && o.subjectId === s.id) ?? null;
  }

  protected summary(o: OverwriteDto): string {
    const a = bitCount(bits(o.allow));
    const d = bitCount(bits(o.deny));
    return `${a ? `✓${a}` : ''}${a && d ? ' ' : ''}${d ? `✗${d}` : ''}`;
  }

  protected addMember(userId: string): void {
    if (!userId) return;
    this.extraMembers.update((l) => [...l, userId]);
    this.selectedKey.set(`member:${userId}`);
  }

  protected async save(s: Subject): Promise<void> {
    await this.write(
      s,
      permissionsToString(this.draft().allow),
      permissionsToString(this.draft().deny),
    );
  }

  protected async reset(s: Subject): Promise<void> {
    await this.write(s, '0', '0');
  }

  private async write(s: Subject, allow: string, deny: string): Promise<void> {
    this.saving.set(true);
    try {
      await this.store.setOverwrite(this.projectId(), s.kind, s.id, allow, deny, this.kind());
      await this.load(this.projectId());
      this.notify.info('overwrite.saved');
    } catch (e) {
      this.notify.error(roleErrorKey(e as ApiProblem));
    } finally {
      this.saving.set(false);
    }
  }
}

function bits(value: string): bigint {
  return permissionsFromString(value) ?? 0n;
}
