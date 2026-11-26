import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { TranslocoPipe } from '@jsverse/transloco';
import { Permission, checkRoleAction, permissionsFromString } from '@os-planner/shared/lite';
import type { RoleDto, TeamMemberDto } from '@os-planner/shared';
import { AuthStore, type ApiProblem } from '../../core/auth-store';
import { Notify } from '../../core/notify';
import { RolesStore } from '../../data/roles-store';
import { TeamStore } from '../../data/team-store';
import { Dialogs } from '../../shared/dialogs';
import { roleErrorKey } from './roles-editor';

interface Section {
  key: string;
  role: RoleDto | null;
  members: TeamMemberDto[];
}

/** Who is in the team and which roles they hold: add or remove a role with one click, set a nickname. */
@Component({
  selector: 'app-members-tab',
  imports: [MatButtonModule, MatIconModule, MatMenuModule, TranslocoPipe],
  template: `
    <div data-members-tab>
      @for (s of sections(); track s.key) {
        <h3 class="sec" [attr.data-section]="s.role?.name ?? 'members'">
          @if (s.role) {
            <span class="dot" [style.background]="s.role.color ?? 'var(--text-dim)'"></span
            >{{ s.role.name }}
          } @else {
            {{ 'team.members' | transloco }}
          }
          <span class="count">{{ s.members.length }}</span>
        </h3>
        <ul class="members">
          @for (m of s.members; track m.userId) {
            <li [attr.data-member-id]="m.userId">
              <span class="avatar">{{
                (m.nickname || m.displayName).charAt(0).toUpperCase()
              }}</span>
              <span class="who">
                <span class="n" data-name>{{ m.nickname || m.displayName }}</span>
                @if (m.nickname) {
                  <span class="muted real">{{ m.displayName }}</span>
                }
              </span>
              @if (m.isOwner) {
                <span class="tag">{{ 'team.owner' | transloco }}</span>
              }
              <span class="chips">
                @for (r of rolesOf(m); track r.id) {
                  <span class="chip" [attr.data-chip]="r.name">
                    <span class="dot" [style.background]="r.color ?? 'var(--text-dim)'"></span
                    >{{ r.name }}
                    @if (canChange(r)) {
                      <button
                        type="button"
                        class="x"
                        (click)="remove(m, r)"
                        [attr.aria-label]="'roles.removeFrom' | transloco: { role: r.name }"
                        data-action="remove-role"
                      >
                        <mat-icon>close</mat-icon>
                      </button>
                    }
                  </span>
                }
                @if (addable(m).length) {
                  <button
                    type="button"
                    class="add"
                    [matMenuTriggerFor]="menu"
                    [attr.aria-label]="'roles.addRole' | transloco"
                    data-action="add-role"
                  >
                    <mat-icon>add</mat-icon>
                  </button>
                  <mat-menu #menu="matMenu">
                    @for (r of addable(m); track r.id) {
                      <button
                        mat-menu-item
                        type="button"
                        (click)="add(m, r)"
                        [attr.data-role-option]="r.name"
                      >
                        <span class="dot" [style.background]="r.color ?? 'var(--text-dim)'"></span
                        >{{ r.name }}
                      </button>
                    }
                  </mat-menu>
                }
              </span>
              @if (canNickname(m)) {
                <button
                  mat-icon-button
                  type="button"
                  (click)="nickname(m)"
                  [attr.aria-label]="'members.nickname' | transloco"
                  data-action="nickname"
                >
                  <mat-icon>edit</mat-icon>
                </button>
              }
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: `
    .sec {
      margin: 18px 0 6px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .count {
      font-weight: 400;
    }
    .members {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 4px;
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .avatar {
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      border-radius: 50%;
      background: var(--accent);
      color: var(--mat-sys-on-primary);
      font-weight: 600;
      font-size: 13px;
      flex: none;
    }
    .who {
      display: flex;
      flex-direction: column;
      min-width: 120px;
    }
    .real {
      font-size: 12px;
    }
    .tag {
      font-size: 12px;
      padding: 1px 8px;
      border-radius: 10px;
      background: var(--surface-3);
      color: var(--text-dim);
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      flex: 1;
      justify-content: flex-end;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 4px 2px 8px;
      border-radius: 12px;
      background: var(--surface-3);
      font-size: 13px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
      flex: none;
    }
    .x,
    .add {
      border: 0;
      background: none;
      color: var(--text-dim);
      cursor: pointer;
      padding: 0;
      display: grid;
      place-items: center;
      border-radius: 50%;
    }
    .x mat-icon,
    .add mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
    }
    .add {
      width: 24px;
      height: 24px;
      border: 1px dashed var(--border);
    }
  `,
})
export class MembersTab {
  readonly teamId = input.required<string>();

  private readonly teams = inject(TeamStore);
  private readonly store = inject(RolesStore);
  private readonly auth = inject(AuthStore);
  private readonly notify = inject(Notify);
  private readonly dialogs = inject(Dialogs);

  private readonly roles = signal<RoleDto[]>([]);
  private readonly members = computed(() => this.teams.membersOf(this.teamId()));
  private readonly actor = computed(() =>
    this.store.actor({ kind: 'team', id: this.teamId() }, this.roles()),
  );
  private readonly byId = computed(() => new Map(this.roles().map((r) => [r.id, r])));

  /** Hoisted roles get a section of their own (most powerful first); everybody else is under "Members". */
  protected readonly sections = computed<Section[]>(() => {
    const hoisted = this.roles()
      .filter((r) => r.hoist && !r.isEveryone)
      .sort((a, b) => b.position - a.position);
    const sections = new Map<string, Section>(
      hoisted.map((r) => [r.id, { key: r.id, role: r, members: [] }]),
    );
    const rest: Section = { key: 'rest', role: null, members: [] };
    for (const m of this.members()) {
      const top = hoisted.find((r) => m.roleIds.includes(r.id));
      (top ? sections.get(top.id)! : rest).members.push(m);
    }
    return [...sections.values(), rest].filter((s) => s.members.length);
  });

  constructor() {
    effect(() => {
      const id = this.teamId();
      untracked(() => void this.load(id));
    });
  }

  private async load(teamId: string): Promise<void> {
    try {
      this.roles.set(await this.store.roles({ kind: 'team', id: teamId }));
    } catch (e) {
      this.notify.error(roleErrorKey(e as ApiProblem));
    }
  }

  protected rolesOf(m: TeamMemberDto): RoleDto[] {
    return m.roleIds
      .map((id) => this.byId().get(id))
      .filter((r): r is RoleDto => !!r)
      .sort((a, b) => b.position - a.position);
  }

  private mayAssign(r: RoleDto): boolean {
    return (
      checkRoleAction(this.actor(), 'assign', {
        position: r.position,
        isEveryone: r.isEveryone,
        permissions: permissionsFromString(r.permissions) ?? 0n,
      }) === null
    );
  }

  protected canChange(r: RoleDto): boolean {
    return this.mayAssign(r);
  }

  /** Roles the person may give to this member and that the member does not have yet. */
  protected addable(m: TeamMemberDto): RoleDto[] {
    return this.roles()
      .filter(
        (r) =>
          !r.isEveryone && r.projectId === null && !m.roleIds.includes(r.id) && this.mayAssign(r),
      )
      .sort((a, b) => b.position - a.position);
  }

  protected canNickname(m: TeamMemberDto): boolean {
    return (
      m.userId === this.auth.userId() || (this.actor().perms & Permission.MANAGE_MEMBERS) !== 0n
    );
  }

  protected async add(m: TeamMemberDto, r: RoleDto): Promise<void> {
    await this.run(() => this.store.assign({ kind: 'team', id: this.teamId() }, m.userId, r.id));
  }

  protected async remove(m: TeamMemberDto, r: RoleDto): Promise<void> {
    await this.run(() => this.store.unassign({ kind: 'team', id: this.teamId() }, m.userId, r.id));
  }

  protected async nickname(m: TeamMemberDto): Promise<void> {
    const answer = await this.dialogs.prompt({
      titleKey: 'members.nickname',
      labelKey: 'members.nicknameLabel',
      value: m.nickname ?? '',
      confirmKey: 'common.save',
    });
    if (answer?.action !== 'ok') return;
    await this.run(() =>
      this.store.setNickname(this.teamId(), m.userId, answer.value.trim() || null),
    );
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      await this.load(this.teamId()); // member counts
    } catch (e) {
      this.notify.error(roleErrorKey(e as ApiProblem));
    }
  }
}
