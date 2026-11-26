import { CdkDrag, CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';
import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  ALL_PERMISSIONS,
  Permission,
  checkRoleAction,
  permissionsFromString,
  permissionsToString,
} from '@os-planner/shared/lite';
import { AuthStore, type ApiProblem } from '../../core/auth-store';
import { Notify } from '../../core/notify';
import { RolesStore, type RoleScope } from '../../data/roles-store';
import { Dialogs } from '../../shared/dialogs';
import type { RoleDto } from '@os-planner/shared';
import { PermissionGrid, type GridValue } from './permission-grid';

interface Draft {
  name: string;
  color: string | null;
  hoist: boolean;
  mentionable: boolean;
  permissions: bigint;
}

const KNOWN_ERRORS = new Set([
  'role_at_or_above',
  'permission_not_held',
  'missing_manage_roles',
  'everyone_protected',
  'administrator_owner_only',
  'last_administrator',
  'role_limit_reached',
  'invalid_order',
]);

/** The message to show for a failed request: the specific reason when the server gave one. */
export function roleErrorKey(p: ApiProblem): string {
  if (p.offline) return 'errors.offline';
  if (KNOWN_ERRORS.has(p.code)) return `roles.err.${p.code}`;
  if (p.status === 403) return 'errors.forbidden';
  if (p.status === 404) return 'errors.notFound';
  return 'errors.generic';
}

/**
 * The roles of a team, or of one project: a list that can be reordered by dragging (most powerful first, @everyone
 * last), and an editor for the selected one. What the person may not do is disabled, with the same rules the server
 * applies (it has the last word and explains a refusal).
 */
@Component({
  selector: 'app-roles-editor',
  imports: [
    CdkDropList,
    CdkDrag,
    FormsModule,
    MatButtonModule,
    MatIconModule,
    TranslocoPipe,
    PermissionGrid,
  ],
  template: `
    <div class="roles" data-roles-editor [attr.data-scope]="scope().kind">
      <aside>
        <div class="head">
          <h3>
            {{ (scope().kind === 'team' ? 'roles.title' : 'roles.projectTitle') | transloco }}
          </h3>
          <button
            mat-stroked-button
            type="button"
            (click)="create()"
            [disabled]="!canCreate()"
            data-action="new-role"
          >
            <mat-icon>add</mat-icon>{{ 'roles.new' | transloco }}
          </button>
        </div>
        @if (movable()) {
          <p class="muted tiny">{{ 'roles.dragHint' | transloco }}</p>
        }

        <div cdkDropList (cdkDropListDropped)="dropped($event)" class="list" data-role-list>
          @for (r of ordered(); track r.id) {
            <div
              class="role"
              cdkDrag
              [cdkDragDisabled]="!canMove(r)"
              [class.on]="r.id === selectedId()"
              [attr.data-role-row]="r.name"
              (click)="select(r.id)"
              (keydown.enter)="select(r.id)"
              tabindex="0"
              role="button"
            >
              <mat-icon class="grip" aria-hidden="true">{{
                canMove(r) ? 'drag_indicator' : 'lock'
              }}</mat-icon>
              <span class="dot" [style.background]="r.color ?? 'var(--text-dim)'"></span>
              <span class="name">{{ r.name }}</span>
              <span class="count" [attr.title]="'roles.members' | transloco">{{
                r.memberCount
              }}</span>
            </div>
          } @empty {
            <p class="muted">{{ 'roles.none' | transloco }}</p>
          }
        </div>
        @if (everyone(); as e) {
          <div
            class="role everyone"
            [class.on]="e.id === selectedId()"
            [attr.data-role-row]="e.name"
            (click)="select(e.id)"
            (keydown.enter)="select(e.id)"
            tabindex="0"
            role="button"
          >
            <mat-icon class="grip" aria-hidden="true">alternate_email</mat-icon>
            <span class="dot" style="background: var(--text-dim)"></span>
            <span class="name">{{ e.name }}</span>
            <span class="count">{{ e.memberCount }}</span>
          </div>
        }
      </aside>

      <section class="editor">
        @if (selected(); as r) {
          @if (!canEdit()) {
            <p class="notice" data-readonly>{{ 'roles.readOnly' | transloco }}</p>
          }
          <div class="fields">
            <label class="f">
              <span>{{ 'roles.name' | transloco }}</span>
              <input
                name="role-name"
                [ngModel]="draft().name"
                (ngModelChange)="patch({ name: $event })"
                [disabled]="!canEditFields()"
                maxlength="40"
              />
            </label>
            <div class="f">
              <span>{{ 'roles.color' | transloco }}</span>
              <span class="color">
                <input
                  type="color"
                  name="role-color"
                  [ngModel]="draft().color ?? '#99aab5'"
                  (ngModelChange)="patch({ color: $event })"
                  [disabled]="!canEditFields()"
                  [attr.aria-label]="'roles.color' | transloco"
                />
                @if (draft().color) {
                  <button
                    type="button"
                    class="clear"
                    (click)="patch({ color: null })"
                    [disabled]="!canEditFields()"
                    [attr.aria-label]="'roles.noColor' | transloco"
                  >
                    <mat-icon>close</mat-icon>
                  </button>
                }
              </span>
            </div>
            <label class="check-row">
              <input
                type="checkbox"
                name="role-hoist"
                [ngModel]="draft().hoist"
                (ngModelChange)="patch({ hoist: $event })"
                [disabled]="!canEditFields()"
              />
              <span>{{ 'roles.hoist' | transloco }}</span>
            </label>
            <label class="check-row">
              <input
                type="checkbox"
                name="role-mentionable"
                [ngModel]="draft().mentionable"
                (ngModelChange)="patch({ mentionable: $event })"
                [disabled]="!canEditFields()"
              />
              <span>{{ 'roles.mentionable' | transloco }}</span>
            </label>
          </div>

          <h4 class="sec">{{ 'roles.permissions' | transloco }}</h4>
          <app-permission-grid
            mode="check"
            [allow]="draft().permissions"
            [editable]="editableBits()"
            (changed)="patch({ permissions: $event.allow })"
          />

          <div class="actions">
            <button
              mat-flat-button
              type="button"
              (click)="save()"
              [disabled]="!dirty() || saving() || !canEdit()"
              [attr.data-dirty]="dirty()"
              data-action="save-role"
            >
              {{ 'common.save' | transloco }}
            </button>
            @if (!r.isEveryone) {
              <button
                mat-stroked-button
                type="button"
                class="danger"
                (click)="remove()"
                [disabled]="!canDelete()"
                data-action="delete-role"
              >
                <mat-icon>delete</mat-icon>{{ 'common.delete' | transloco }}
              </button>
            }
          </div>
        } @else if (loaded()) {
          <p class="muted">{{ 'roles.pick' | transloco }}</p>
        }
      </section>
    </div>
  `,
  styles: `
    .roles {
      display: grid;
      grid-template-columns: minmax(200px, 260px) minmax(0, 1fr);
      gap: 24px;
      align-items: start;
    }
    @media (max-width: 760px) {
      .roles {
        grid-template-columns: 1fr;
      }
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    h3 {
      margin: 0;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
    }
    .tiny {
      font-size: 12px;
      margin: 6px 0;
    }
    .list {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin: 8px 0 2px;
    }
    .role {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 8px;
      border: 1px solid transparent;
      cursor: pointer;
      background: var(--surface-1, transparent);
    }
    .role:hover {
      background: var(--surface-3);
    }
    .role.on {
      background: var(--surface-3);
      border-color: var(--border);
      font-weight: 600;
    }
    .role.everyone {
      margin-top: 6px;
    }
    .grip {
      font-size: 18px;
      width: 18px;
      height: 18px;
      color: var(--text-dim);
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
    .count {
      font-size: 12px;
      color: var(--text-dim);
    }
    .cdk-drag-preview {
      background: var(--surface-2);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgb(0 0 0 / 0.3);
    }
    .cdk-drag-placeholder {
      opacity: 0.3;
    }
    .notice {
      padding: 8px 12px;
      border-radius: 8px;
      background: var(--surface-3);
      color: var(--text-dim);
      margin: 0 0 12px;
    }
    .fields {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      align-items: end;
    }
    .f {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 13px;
      color: var(--text-dim);
    }
    .f input:not([type='color']) {
      height: 38px;
      padding: 0 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-2);
      color: var(--text);
      font: inherit;
    }
    .color {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .color input {
      width: 48px;
      height: 38px;
      padding: 2px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-2);
    }
    .clear {
      border: 0;
      background: none;
      color: var(--text-dim);
      cursor: pointer;
    }
    .check-row {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text);
    }
    .check-row input {
      width: 18px;
      height: 18px;
      accent-color: var(--accent);
    }
    .sec {
      margin: 20px 0 6px;
      font-size: 14px;
    }
    .actions {
      display: flex;
      gap: 10px;
      margin-top: 20px;
      position: sticky;
      bottom: 0;
      padding: 10px 0;
      background: var(--bg, var(--surface-1));
    }
    .danger {
      color: var(--mat-sys-error);
    }
  `,
})
export class RolesEditor {
  readonly scope = input.required<RoleScope>();
  /** Fired whenever the roles were (re)read from the server: after a change, so other panels can follow. */
  readonly changed = output<void>();

  private readonly store = inject(RolesStore);
  private readonly auth = inject(AuthStore);
  private readonly notify = inject(Notify);
  private readonly dialogs = inject(Dialogs);

  protected readonly roles = signal<RoleDto[]>([]);
  protected readonly loaded = signal(false);
  protected readonly selectedId = signal<string | null>(null);
  protected readonly draft = signal<Draft>({
    name: '',
    color: null,
    hoist: false,
    mentionable: false,
    permissions: 0n,
  });
  protected readonly saving = signal(false);
  /** The roles of this project the person holds (project scope), for working out their rank. */
  private readonly myProjectRoles = signal<string[]>([]);

  /** The roles that belong to this scope itself (the roles of projects above are used, not edited, here). */
  private readonly own = computed(() => {
    const s = this.scope();
    return this.roles().filter((r) =>
      s.kind === 'team' ? r.projectId === null : r.projectId === s.id,
    );
  });
  protected readonly ordered = computed(() =>
    this.own()
      .filter((r) => !r.isEveryone)
      .sort((a, b) => b.position - a.position),
  );
  protected readonly everyone = computed(() => this.own().find((r) => r.isEveryone) ?? null);
  protected readonly selected = computed(
    () => this.own().find((r) => r.id === this.selectedId()) ?? null,
  );

  private readonly actor = computed(() =>
    this.store.actor(this.scope(), this.roles(), this.myProjectRoles()),
  );

  protected readonly canCreate = computed(
    () => checkRoleAction(this.actor(), 'create', null, 0n) === null,
  );
  protected readonly movable = computed(() => this.ordered().some((r) => this.canMove(r)));
  protected readonly canEdit = computed(() => {
    const r = this.selected();
    return !!r && checkRoleAction(this.actor(), 'edit', this.target(r)) === null;
  });
  protected readonly canEditFields = computed(() => this.canEdit() && !this.selected()?.isEveryone);
  protected readonly canDelete = computed(() => {
    const r = this.selected();
    return !!r && !r.isEveryone && checkRoleAction(this.actor(), 'delete', this.target(r)) === null;
  });
  /** The permissions the person may switch on or off in the selected role: the ones they hold (and only the owner may give @everyone ADMINISTRATOR). */
  protected readonly editableBits = computed(() => {
    const a = this.actor();
    if (!this.canEdit()) return 0n;
    let bits = a.isOwner ? ALL_PERMISSIONS : a.perms;
    if (this.selected()?.isEveryone && !a.isOwner) bits &= ~Permission.ADMINISTRATOR;
    return bits;
  });

  protected readonly dirty = computed(() => {
    const r = this.selected();
    const d = this.draft();
    return (
      !!r &&
      (d.name !== r.name ||
        d.color !== r.color ||
        d.hoist !== r.hoist ||
        d.mentionable !== r.mentionable ||
        d.permissions !== (permissionsFromString(r.permissions) ?? 0n))
    );
  });

  constructor() {
    effect(() => {
      const s = this.scope();
      untracked(() => void this.load(s));
    });
    effect(() => {
      const r = this.selected();
      untracked(() =>
        this.draft.set(
          r
            ? {
                name: r.name,
                color: r.color,
                hoist: r.hoist,
                mentionable: r.mentionable,
                permissions: permissionsFromString(r.permissions) ?? 0n,
              }
            : { name: '', color: null, hoist: false, mentionable: false, permissions: 0n },
        ),
      );
    });
  }

  private target(r: RoleDto) {
    return {
      position: r.position,
      isEveryone: r.isEveryone,
      permissions: permissionsFromString(r.permissions) ?? 0n,
    };
  }

  protected canMove(r: RoleDto): boolean {
    const a = this.actor();
    if (a.isOwner) return true;
    return (a.perms & Permission.MANAGE_ROLES) !== 0n && r.position < a.rank;
  }

  private async load(scope: RoleScope, select?: string): Promise<void> {
    try {
      const [roles, mine] = await Promise.all([
        this.store.roles(scope),
        scope.kind === 'project' ? this.store.projectMembers(scope.id) : Promise.resolve(null),
      ]);
      this.roles.set(roles);
      const me = mine?.find((m) => m.userId === this.auth.userId());
      this.myProjectRoles.set(me?.roleIds ?? []);
      const keep = select ?? this.selectedId();
      const own = roles.filter((r) =>
        scope.kind === 'team' ? r.projectId === null : r.projectId === scope.id,
      );
      this.selectedId.set(
        own.some((r) => r.id === keep)
          ? keep
          : (own.filter((r) => !r.isEveryone).sort((a, b) => b.position - a.position)[0]?.id ??
              own[0]?.id ??
              null),
      );
    } catch (e) {
      this.fail(e);
    } finally {
      this.loaded.set(true);
      this.changed.emit();
    }
  }

  private fail(e: unknown): void {
    this.notify.error(roleErrorKey(e as ApiProblem));
  }

  protected select(id: string): void {
    this.selectedId.set(id);
  }

  protected patch(change: Partial<Draft>): void {
    this.draft.update((d) => ({ ...d, ...change }));
  }

  protected async create(): Promise<void> {
    const answer = await this.dialogs.prompt({
      titleKey: 'roles.new',
      labelKey: 'roles.name',
      confirmKey: 'common.save',
    });
    if (answer?.action !== 'ok' || !answer.value.trim()) return;
    try {
      const created = await this.store.createRole(this.scope(), { name: answer.value.trim() });
      await this.load(this.scope(), created.id);
    } catch (e) {
      this.fail(e);
    }
  }

  protected async save(): Promise<void> {
    const r = this.selected();
    if (!r) return;
    const d = this.draft();
    this.saving.set(true);
    try {
      await this.store.updateRole(r.id, {
        ...(d.name !== r.name && { name: d.name.trim() }),
        ...(d.color !== r.color && { color: d.color }),
        ...(d.hoist !== r.hoist && { hoist: d.hoist }),
        ...(d.mentionable !== r.mentionable && { mentionable: d.mentionable }),
        ...(d.permissions !== (permissionsFromString(r.permissions) ?? 0n) && {
          permissions: permissionsToString(d.permissions),
        }),
      });
      await this.store.refresh(this.scope());
      await this.load(this.scope(), r.id);
      this.notify.info('roles.saved');
    } catch (e) {
      this.fail(e);
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const r = this.selected();
    if (!r) return;
    const sure = await this.dialogs.confirm({
      titleKey: 'roles.deleteTitle',
      messageKey: 'roles.deleteMessage',
      params: { name: r.name, count: r.memberCount },
      confirmKey: 'common.delete',
      danger: true,
    });
    if (!sure) return;
    try {
      await this.store.deleteRole(r.id);
      await this.store.refresh(this.scope());
      this.selectedId.set(null);
      await this.load(this.scope());
    } catch (e) {
      this.fail(e);
    }
  }

  protected async dropped(event: CdkDragDrop<unknown>): Promise<void> {
    if (event.previousIndex === event.currentIndex) return;
    const ids = this.ordered().map((r) => r.id);
    const [moved] = ids.splice(event.previousIndex, 1);
    ids.splice(event.currentIndex, 0, moved!);
    try {
      this.roles.set(await this.store.reorder(this.scope(), ids));
    } catch (e) {
      this.fail(e);
      await this.load(this.scope()); // back to what the server has
    }
  }
}
