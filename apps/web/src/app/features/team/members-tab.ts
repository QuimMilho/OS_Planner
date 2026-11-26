import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { TranslocoPipe } from '@jsverse/transloco';
import { Permission, checkRoleAction, permissionsFromString } from '@os-planner/shared/lite';
import type { RoleDto, TeamMemberDto } from '@os-planner/shared';
import { AuthStore, toProblem, type ApiProblem } from '../../core/auth-store';
import { Notify } from '../../core/notify';
import { MembershipStore } from '../../data/membership-store';
import { DmStore } from '../../data/dm-store';
import { PresenceStore } from '../../data/presence-store';
import { RolesStore } from '../../data/roles-store';
import { TeamStore } from '../../data/team-store';
import { Dialogs } from '../../shared/dialogs';
import { accessErrorKey } from './access-tabs';
import { roleErrorKey } from './roles-editor';

interface Section {
  key: string;
  role: RoleDto | null;
  members: TeamMemberDto[];
}

/** Who is in the team and which roles they hold: add or remove a role with one click, set a nickname. */
@Component({
  selector: 'app-members-tab',
  imports: [FormsModule, MatButtonModule, MatIconModule, MatMenuModule, TranslocoPipe],
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
              <span class="avatar"
                >{{ (m.nickname || m.displayName).charAt(0).toUpperCase()
                }}<i class="presence" [class]="'presence ' + presence.statusOf(m.userId)" data-presence [attr.data-status]="presence.statusOf(m.userId)" [attr.title]="'presence.' + presence.statusOf(m.userId) | transloco"></i
              ></span>
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
              @if (m.userId !== me()) {
                <button
                  mat-icon-button
                  type="button"
                  (click)="message(m)"
                  [attr.aria-label]="'dm.message' | transloco"
                  [title]="'dm.message' | transloco"
                  data-action="message-member"
                >
                  <mat-icon>chat</mat-icon>
                </button>
              }
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
              @if (canModerate(m)) {
                <button
                  mat-icon-button
                  type="button"
                  [matMenuTriggerFor]="modMenu"
                  [attr.aria-label]="'members.moderate' | transloco"
                  data-action="member-menu"
                >
                  <mat-icon>more_vert</mat-icon>
                </button>
                <mat-menu #modMenu="matMenu">
                  <button mat-menu-item type="button" (click)="kick(m)" data-action="kick">
                    <mat-icon>person_remove</mat-icon>{{ 'members.kick' | transloco }}
                  </button>
                  <button mat-menu-item type="button" (click)="ban(m)" data-action="ban">
                    <mat-icon>block</mat-icon>{{ 'members.ban' | transloco }}
                  </button>
                </mat-menu>
              }
            </li>
          }
        </ul>
      }

      <section class="danger" data-danger-zone>
        <h3>{{ 'members.leaveTitle' | transloco }}</h3>
        @if (isOwner()) {
          <p class="muted">{{ 'ownership.transfer.hint' | transloco }}</p>
          <form class="transfer" (ngSubmit)="transfer()" data-transfer-form>
            <label>
              {{ 'ownership.transfer.to' | transloco }}
              <select name="heir" [(ngModel)]="heir" data-field="heir">
                <option value="">—</option>
                @for (m of heirs(); track m.userId) {
                  <option [value]="m.userId">{{ m.nickname || m.displayName }}</option>
                }
              </select>
            </label>
            <label>
              {{ 'ownership.transfer.typeName' | transloco: { name: teamName() } }}
              <input name="confirmName" [(ngModel)]="confirmName" autocomplete="off" data-field="transfer-name" />
            </label>
            <label>
              {{ 'ownership.transfer.password' | transloco }}
              <input type="password" name="password" [(ngModel)]="password" autocomplete="current-password" data-field="transfer-password" />
            </label>
            <button mat-flat-button type="submit" [disabled]="!canTransfer() || transferring()" data-action="transfer">
              {{ 'ownership.transfer.button' | transloco }}
            </button>
          </form>
        } @else {
          <p class="muted">{{ 'members.leaveHint' | transloco }}</p>
          <button mat-stroked-button type="button" (click)="leave()" data-action="leave-team">
            {{ 'members.leave' | transloco }}
          </button>
        }
      </section>
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
      position: relative;
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
    .presence {
      position: absolute;
      right: -2px;
      bottom: -2px;
      width: 11px;
      height: 11px;
      border-radius: 50%;
      border: 2px solid var(--surface);
      background: var(--text-dim);
      opacity: 0.5;
    }
    .presence.online {
      background: #2f9e44;
      opacity: 1;
    }
    .presence.idle {
      background: #f59f00;
      opacity: 1;
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
    .danger {
      margin-top: 36px;
      padding: 14px 16px;
      border: 1px solid color-mix(in srgb, var(--mat-sys-error) 50%, var(--border));
      border-radius: 10px;
    }
    .danger h3 {
      margin: 0 0 6px;
      font-size: 15px;
    }
    .transfer {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: flex-end;
    }
    .transfer label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 13px;
      color: var(--text-dim);
    }
    .transfer select,
    .transfer input {
      font: inherit;
      padding: 6px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface-2);
      color: var(--text);
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
  private readonly membership = inject(MembershipStore);
  private readonly router = inject(Router);
  protected readonly presence = inject(PresenceStore);
  private readonly dms = inject(DmStore);
  protected readonly me = computed(() => this.auth.userId());

  /** Opens (or starts) the conversation with a member. If it is not possible, the answer is the same for every reason. */
  protected async message(m: TeamMemberDto): Promise<void> {
    try {
      const dm = await this.dms.start(m.userId);
      await this.router.navigate(['/app/dm', dm.id]);
    } catch {
      this.notify.error('dm.notAllowed');
    }
  }

  /** Follow who is online while the member list is on screen. */
  private readonly watching = effect((onCleanup) => onCleanup(this.presence.watch(this.teamId())));

  protected heir = '';
  protected confirmName = '';
  protected password = '';
  protected readonly transferring = signal(false);
  private readonly roles = signal<RoleDto[]>([]);
  protected readonly team = computed(() => this.teams.teamById().get(this.teamId()) ?? null);
  protected readonly teamName = computed(() => this.team()?.name ?? '');
  protected readonly isOwner = computed(() => this.team()?.isOwner === true);
  /** Whom the owner can hand the team to: anybody else in it. */
  protected readonly heirs = computed(() => this.members().filter((m) => m.userId !== this.auth.userId()));
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

  /**
   * Whether the person may remove or ban this member: they hold "Manage members" and rank above them (the owner outranks
   * everybody; nobody removes the owner or themselves this way). The server checks the same rule.
   */
  protected canModerate(m: TeamMemberDto): boolean {
    if (m.isOwner || m.userId === this.auth.userId()) return false;
    const actor = this.actor();
    if (!actor.isOwner && (actor.perms & Permission.MANAGE_MEMBERS) === 0n) return false;
    if (actor.isOwner) return true;
    const rank = this.rolesOf(m).reduce((top, r) => Math.max(top, r.position), 0);
    return actor.rank > rank;
  }

  protected async kick(m: TeamMemberDto): Promise<void> {
    const ok = await this.dialogs.confirm({
      titleKey: 'members.kickTitle',
      messageKey: 'members.kickText',
      params: { name: m.nickname || m.displayName },
      confirmKey: 'members.kick',
      danger: true,
    });
    if (!ok) return;
    await this.moderate(() => this.membership.kick(this.teamId(), m.userId));
  }

  protected async ban(m: TeamMemberDto): Promise<void> {
    const answer = await this.dialogs.prompt({
      titleKey: 'members.banTitle',
      labelKey: 'members.banReason',
      confirmKey: 'members.ban',
    });
    if (answer?.action !== 'ok') return;
    await this.moderate(() => this.membership.ban(this.teamId(), m.userId, answer.value));
  }

  private async moderate(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
      await this.load(this.teamId());
    } catch (e) {
      this.notify.error(accessErrorKey(e));
    }
  }

  protected async leave(): Promise<void> {
    const ok = await this.dialogs.confirm({
      titleKey: 'members.leaveTitle',
      messageKey: 'members.leaveConfirm',
      params: { name: this.teamName() },
      confirmKey: 'members.leave',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.membership.leave(this.teamId());
      await this.router.navigateByUrl('/app');
    } catch (e) {
      this.notify.error(accessErrorKey(e));
    }
  }

  protected canTransfer(): boolean {
    return !!this.heir && this.confirmName.trim() === this.teamName() && !!this.password;
  }

  protected async transfer(): Promise<void> {
    if (!this.canTransfer()) return;
    this.transferring.set(true);
    try {
      await this.membership.transferOwnership(this.teamId(), this.heir, this.password);
      this.heir = this.confirmName = this.password = '';
      this.notify.info('ownership.transfer.done');
      await this.load(this.teamId());
    } catch (e) {
      this.notify.error(
        toProblem(e).code === 'invalid_password' ? 'ownership.transfer.wrongPassword' : accessErrorKey(e),
      );
    } finally {
      this.transferring.set(false);
    }
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
