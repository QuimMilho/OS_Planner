import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { Permission } from '@os-planner/shared/lite';
import type { RoleDto } from '@os-planner/shared';
import type { ApiProblem } from '../../core/auth-store';
import { RolesStore } from '../../data/roles-store';
import { TeamStore } from '../../data/team-store';
import { Notify } from '../../core/notify';
import { NotFoundPage } from '../shell/not-found';
import { AuditTab } from './audit-tab';
import { BansTab, DiscoverTab, RequestsTab } from './access-tabs';
import { InvitesTab } from './invites-tab';
import { MembersTab } from './members-tab';
import { OverwriteEditor } from './overwrite-editor';
import { RolesEditor, roleErrorKey } from './roles-editor';
import { ViewAs } from './view-as';

type Check = 'loading' | 'ready' | 'missing';
type TeamTab =
  | 'members'
  | 'invites'
  | 'requests'
  | 'bans'
  | 'discover'
  | 'roles'
  | 'viewAs'
  | 'audit';

const PAGE_STYLES = `
  .page {
    max-width: 1040px;
    margin: 0 auto;
    padding: 24px 20px 64px;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-dim);
    text-decoration: none;
    font-size: 14px;
  }
  h1 {
    margin: 8px 0 16px;
    font-size: 26px;
    overflow-wrap: anywhere;
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 20px;
    overflow-x: auto;
  }
  .tabs button {
    border: 0;
    background: none;
    color: var(--text-dim);
    font: inherit;
    padding: 10px 14px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    white-space: nowrap;
  }
  .tabs button[aria-selected='true'] {
    color: var(--text);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
  section.block {
    margin-top: 32px;
  }
  .badge {
    display: inline-block;
    min-width: 18px;
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 9px;
    background: var(--accent);
    color: var(--mat-sys-on-primary);
    font-size: 12px;
    line-height: 18px;
    text-align: center;
  }
  h2 {
    font-size: 14px;
    margin: 0 0 12px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .notice {
    padding: 10px 14px;
    border-radius: 8px;
    background: var(--surface-3);
    color: var(--text-dim);
  }
`;

/**
 * Team settings: the members with their roles, the roles themselves, "view as", and the audit log. Every tab is shown
 * only to people who may use it; the server checks again on every request.
 */
@Component({
  selector: 'app-team-settings-page',
  imports: [
    RouterLink,
    MatIconModule,
    TranslocoPipe,
    NotFoundPage,
    RolesEditor,
    MembersTab,
    AuditTab,
    ViewAs,
    InvitesTab,
    RequestsTab,
    BansTab,
    DiscoverTab,
  ],
  template: `
    @switch (view()) {
      @case ('missing') {
        <app-not-found />
      }
      @case ('ready') {
        <div class="page" data-team-settings>
          <a class="back" [routerLink]="['/app/t', teamId()]"
            ><mat-icon>arrow_back</mat-icon>{{ team()?.name }}</a
          >
          <h1>{{ 'team.settingsTitle' | transloco }}</h1>

          <div class="tabs" role="tablist">
            @for (t of tabs(); track t) {
              <button
                type="button"
                role="tab"
                [attr.aria-selected]="current() === t"
                [attr.data-tab]="t"
                (click)="pick(t)"
              >
                {{ 'team.tab.' + t | transloco }}
                @if (t === 'requests' && pending() > 0) {
                  <span class="badge" data-requests-badge>{{ pending() }}</span>
                }
              </button>
            }
          </div>

          @switch (current()) {
            @case ('members') {
              <app-members-tab [teamId]="teamId()" />
            }
            @case ('invites') {
              <app-invites-tab [teamId]="teamId()" />
            }
            @case ('requests') {
              <app-requests-tab [teamId]="teamId()" />
            }
            @case ('bans') {
              <app-bans-tab [teamId]="teamId()" />
            }
            @case ('discover') {
              <app-discover-tab [teamId]="teamId()" />
            }
            @case ('roles') {
              <app-roles-editor [scope]="{ kind: 'team', id: teamId() }" />
            }
            @case ('viewAs') {
              <app-view-as
                [where]="{ kind: 'team', id: teamId() }"
                [teamId]="teamId()"
                [roles]="roles()"
              />
            }
            @case ('audit') {
              <app-audit-tab [teamId]="teamId()" />
            }
          }
        </div>
      }
    }
  `,
  styles: PAGE_STYLES,
})
export class TeamSettingsPage {
  readonly teamId = input.required<string>();
  /** `?tab=roles` opens that tab first. */
  readonly tab = input<string>();

  private readonly teams = inject(TeamStore);
  private readonly store = inject(RolesStore);
  private readonly notify = inject(Notify);

  protected readonly roles = signal<RoleDto[]>([]);
  private readonly verified = signal<{ team: string; ok: boolean } | null>(null);
  protected readonly team = computed(() => this.teams.teamById().get(this.teamId()) ?? null);

  protected readonly view = computed<Check>(() => {
    if (this.teams.teams() === null) return 'loading';
    const v = this.verified();
    if (this.team()) return 'ready'; // from the local database: also offline
    return v && v.team === this.teamId() ? 'missing' : 'loading';
  });

  protected readonly tabs = computed<TeamTab[]>(() => {
    const id = this.teamId();
    const roles = this.teams.can(id, Permission.MANAGE_ROLES);
    const members = this.teams.can(id, Permission.MANAGE_MEMBERS);
    return [
      'members',
      ...(this.teams.can(id, Permission.CREATE_INVITES) ? (['invites'] as const) : []),
      ...(members ? (['requests', 'bans'] as const) : []),
      ...(this.teams.can(id, Permission.MANAGE_TEAM) ? (['discover'] as const) : []),
      ...(roles ? (['roles', 'viewAs'] as const) : []),
      ...(this.teams.can(id, Permission.VIEW_AUDIT_LOG) ? (['audit'] as const) : []),
    ];
  });
  protected readonly pending = computed(() => this.teams.pendingRequests(this.teamId()));
  protected readonly current = signal<TeamTab>('members');
  /** Once the person has chosen a tab themselves, a refresh of their permissions must not move them elsewhere. */
  private picked = false;

  constructor() {
    effect(() => {
      const id = this.teamId();
      if (this.teams.teams() === null) return;
      untracked(() => void this.verify(id));
    });
    effect(() => {
      const wanted = this.tab() as TeamTab | undefined;
      const tabs = this.tabs();
      untracked(() => {
        if (this.picked) {
          if (!tabs.includes(this.current())) this.current.set('members'); // the permission for it was taken away
          return;
        }
        this.current.set(
          wanted && tabs.includes(wanted) ? wanted : tabs.includes('roles') ? 'roles' : 'members',
        );
      });
    });
    effect(() => {
      const id = this.teamId();
      if (this.tabs().includes('viewAs')) untracked(() => void this.loadRoles(id));
    });
  }

  protected pick(tab: TeamTab): void {
    this.picked = true;
    this.current.set(tab);
  }

  private async verify(id: string): Promise<void> {
    let ok = false;
    try {
      ok = this.teams.teamById().has(id)
        ? await this.teams.refreshTeam(id)
        : await this.teams.fetchTeam(id);
    } catch {
      ok = this.teams.teamById().has(id); // offline: trust what is stored
    }
    this.verified.set({ team: id, ok });
  }

  private async loadRoles(id: string): Promise<void> {
    try {
      this.roles.set(await this.store.roles({ kind: 'team', id }));
    } catch (e) {
      this.notify.error(roleErrorKey(e as ApiProblem));
    }
  }
}

/**
 * Project settings: who may do what in this project. Overwrites per role and per member (they apply here and in every
 * sub-project), the roles of the project itself, and "view as".
 */
@Component({
  selector: 'app-project-settings-page',
  imports: [
    RouterLink,
    MatIconModule,
    TranslocoPipe,
    NotFoundPage,
    RolesEditor,
    OverwriteEditor,
    ViewAs,
  ],
  template: `
    @switch (view()) {
      @case ('missing') {
        <app-not-found />
      }
      @case ('ready') {
        <div class="page" data-project-settings>
          <a class="back" [routerLink]="['/app/t', teamId(), 'p', projectId()]"
            ><mat-icon>arrow_back</mat-icon>{{ project()?.name }}</a
          >
          <h1>{{ 'project.permissionsTitle' | transloco }}</h1>

          @if (canOverwrite()) {
            <section class="block">
              <h2>{{ 'project.overwrites' | transloco }}</h2>
              <app-overwrite-editor
                [projectId]="projectId()"
                [teamId]="teamId()"
                [roles]="allRoles()"
              />
            </section>
          } @else {
            <p class="notice" data-no-access>{{ 'project.permissionsNoAccess' | transloco }}</p>
          }

          @if (canRoles()) {
            <section class="block">
              <h2>{{ 'roles.projectTitle' | transloco }}</h2>
              <p class="muted">{{ 'roles.projectHint' | transloco }}</p>
              <app-roles-editor
                [scope]="{ kind: 'project', id: projectId() }"
                (changed)="loadRoles()"
              />
            </section>

            <section class="block">
              <h2>{{ 'viewAs.title' | transloco }}</h2>
              <app-view-as
                [where]="{ kind: 'project', id: projectId() }"
                [teamId]="teamId()"
                [roles]="allRoles()"
              />
            </section>
          }
        </div>
      }
    }
  `,
  styles: PAGE_STYLES,
})
export class ProjectSettingsPage {
  readonly teamId = input.required<string>();
  readonly projectId = input.required<string>();

  private readonly teams = inject(TeamStore);
  private readonly store = inject(RolesStore);
  private readonly notify = inject(Notify);

  /** Team roles, @everyone and the roles of this project and above: everybody an overwrite can name. */
  protected readonly allRoles = signal<RoleDto[]>([]);
  private readonly verified = signal<{ project: string; ok: boolean } | null>(null);
  protected readonly project = computed(() => {
    const p = this.teams.projectById().get(this.projectId());
    return p && p.teamId === this.teamId() ? p : null;
  });

  protected readonly view = computed<Check>(() => {
    if (this.teams.teams() === null) return 'loading';
    if (this.project()) return 'ready';
    const v = this.verified();
    return v && v.project === this.projectId() ? 'missing' : 'loading';
  });

  protected readonly canOverwrite = computed(
    () =>
      this.teams.can(this.teamId(), Permission.MANAGE_PROJECTS, this.projectId()) ||
      this.teams.can(this.teamId(), Permission.MANAGE_ROLES, this.projectId()),
  );
  protected readonly canRoles = computed(() =>
    this.teams.can(this.teamId(), Permission.MANAGE_ROLES, this.projectId()),
  );

  constructor() {
    effect(() => {
      const team = this.teamId();
      const project = this.projectId();
      if (this.teams.teams() === null) return;
      untracked(() => void this.verify(team, project));
    });
    effect(() => {
      this.projectId();
      if (this.view() === 'ready') untracked(() => void this.loadRoles());
    });
  }

  private async verify(team: string, project: string): Promise<void> {
    let ok = false;
    try {
      ok = this.teams.teamById().has(team)
        ? await this.teams.refreshTeam(team)
        : await this.teams.fetchTeam(team);
      ok = ok && this.teams.projectById().get(project)?.teamId === team;
    } catch {
      ok = this.teams.projectById().get(project)?.teamId === team;
    }
    this.verified.set({ project, ok });
  }

  protected async loadRoles(): Promise<void> {
    try {
      const [team, project] = await Promise.all([
        this.store.roles({ kind: 'team', id: this.teamId() }),
        this.store.roles({ kind: 'project', id: this.projectId() }),
      ]);
      this.allRoles.set([...team, ...project]);
    } catch (e) {
      this.notify.error(roleErrorKey(e as ApiProblem));
    }
  }
}
