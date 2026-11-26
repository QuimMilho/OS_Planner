import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { NotFoundPage } from '../shell/not-found';
import { Permission } from '@os-planner/shared/lite';
import { TeamStore } from '../../data/team-store';
import { TreeStore } from '../../data/tree-store';
import { openNotifyDialog } from '../notifications/notify-dialog';
import { TeamUi } from './team-ui';

type View = 'loading' | 'ready' | 'missing';

/**
 * A team's home, or the home of one of its projects. Read from the local database so it opens
 * offline; a team or project the person cannot see looks exactly like one that does not exist.
 */
@Component({
  selector: 'app-team-page',
  imports: [RouterLink, MatButtonModule, MatIconModule, TranslocoPipe, NotFoundPage],
  template: `
    @switch (view()) {
      @case ('missing') {
        <app-not-found />
      }
      @case ('ready') {
        @let t = team()!;
        <div class="page" data-team-page>
          <header>
            <h1 data-title>{{ project()?.name ?? t.name }}</h1>
            @if (project()?.description ?? t.description; as d) {
              <p class="muted">{{ d }}</p>
            }
            @if (project()?.archivedAt) {
              <span class="tag">{{ 'project.archived' | transloco }}</span>
            }
            <nav class="links">
              @if (project(); as pr) {
                <button mat-stroked-button type="button" (click)="notifySettings(pr)" data-action="project-notifications">
                  <mat-icon>notifications</mat-icon>{{ 'notif.open' | transloco }}
                </button>
                @if (canPermissions()) {
                  <a mat-stroked-button [routerLink]="['/app/t', t.id, 'p', pr.id, 'settings']" data-action="project-permissions">
                    <mat-icon>lock_person</mat-icon>{{ 'project.permissions' | transloco }}
                  </a>
                }
              } @else {
                <a mat-stroked-button [routerLink]="['/app/t', t.id, 'settings']" data-action="team-settings">
                  <mat-icon>settings</mat-icon>{{ 'team.settings' | transloco }}
                </a>
              }
            </nav>
          </header>

          <section>
            <div class="head">
              <h2>{{ (project() ? 'project.subProjects' : 'team.projects') | transloco }}</h2>
              @if (manage()) {
                <button
                  mat-stroked-button
                  type="button"
                  (click)="ui.newProject(t.id, project()?.id ?? null)"
                  data-action="new-project"
                >
                  <mat-icon>add</mat-icon
                  >{{ (project() ? 'project.newSub' : 'project.new') | transloco }}
                </button>
              }
            </div>
            <ul class="cards">
              @for (p of children(); track p.id) {
                <li>
                  <a [routerLink]="['/app/t', t.id, 'p', p.id]" [class.archived]="!!p.archivedAt"
                    ><mat-icon>folder</mat-icon><span>{{ p.name }}</span></a
                  >
                </li>
              } @empty {
                <li class="muted">{{ 'team.noProjects' | transloco }}</li>
              }
            </ul>
          </section>

          <section>
            <h2>{{ 'team.notebooks' | transloco }}</h2>
            <ul class="cards" data-notebooks>
              @for (n of notebooks(); track n.id) {
                <li class="static">
                  <mat-icon>book</mat-icon><span>{{ n.name }}</span>
                </li>
              } @empty {
                <li class="muted">{{ 'team.noNotebooks' | transloco }}</li>
              }
            </ul>
          </section>

          @if (!project()) {
            <section>
              <h2>
                {{ 'team.members' | transloco }} <span class="count">{{ members().length }}</span>
              </h2>
              <ul class="members" data-members>
                @for (m of members(); track m.userId) {
                  <li>
                    <span class="avatar">{{
                      (m.nickname || m.displayName).charAt(0).toUpperCase()
                    }}</span>
                    <span class="n">{{ m.nickname || m.displayName }}</span>
                    @if (m.isOwner) {
                      <span class="tag">{{ 'team.owner' | transloco }}</span>
                    }
                  </li>
                }
              </ul>
            </section>
          }

          <section class="soon">
            <h2>{{ 'team.boards' | transloco }}</h2>
            <p class="muted">{{ 'team.comingSoon' | transloco }}</p>
            <h2>{{ 'team.channels' | transloco }}</h2>
            <p class="muted">{{ 'team.comingSoon' | transloco }}</p>
          </section>
        </div>
      }
    }
  `,
  styles: `
    .page {
      max-width: 820px;
      margin: 0 auto;
      padding: 28px 20px 64px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 28px;
      overflow-wrap: anywhere;
    }
    header p {
      margin: 0 0 8px;
    }
    section {
      margin-top: 28px;
    }
    h2 {
      font-size: 14px;
      margin: 0 0 8px;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    .head h2 {
      margin: 0;
    }
    .cards {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 10px;
    }
    .cards li:not(.muted) {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface-2);
    }
    .cards a,
    .cards li.static {
      display: flex;
      gap: 10px;
      align-items: center;
      padding: 12px;
      color: var(--text);
      text-decoration: none;
      min-width: 0;
    }
    .cards a:hover {
      background: var(--surface-3);
      border-radius: 10px;
    }
    .cards span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .archived {
      opacity: 0.6;
    }
    .cards mat-icon {
      color: var(--text-dim);
      flex: none;
    }
    .members {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .members li {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 4px;
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
    }
    .links {
      margin-top: 12px;
    }
    .tag {
      font-size: 12px;
      padding: 1px 8px;
      border-radius: 10px;
      background: var(--surface-3);
      color: var(--text-dim);
    }
    .count {
      font-weight: 400;
    }
    .soon {
      opacity: 0.6;
    }
    .soon p {
      margin: 0 0 16px;
    }
  `,
})
export class TeamPage {
  readonly teamId = input.required<string>();
  readonly projectId = input<string>();

  readonly teams = inject(TeamStore);
  readonly ui = inject(TeamUi);
  private readonly tree = inject(TreeStore);
  private readonly dialog = inject(MatDialog);

  protected notifySettings(project: { id: string; name: string }): void {
    openNotifyDialog(this.dialog, { scope: { scopeKind: 'project', scopeId: project.id }, title: project.name });
  }

  /** `null` until a check against the server (or the lack of a network) has settled whether the address is real. */
  private readonly verified = signal<{ team: string; project?: string; ok: boolean } | null>(null);

  readonly team = computed(() => this.teams.teamById().get(this.teamId()) ?? null);
  readonly project = computed(() => {
    const id = this.projectId();
    const p = id ? this.teams.projectById().get(id) : undefined;
    return p && p.teamId === this.teamId() ? p : null;
  });

  readonly view = computed<View>(() => {
    const v = this.verified();
    const stale = !v || v.team !== this.teamId() || v.project !== this.projectId();
    if (this.teams.teams() === null) return 'loading';
    const found = !!this.team() && (!this.projectId() || !!this.project());
    if (found) return 'ready'; // from the local database: also while offline
    return stale ? 'loading' : 'missing';
  });

  readonly manage = computed(() => this.ui.canManage(this.teamId()));
  /** The person may look at (and perhaps change) who can do what in this project. */
  readonly canPermissions = computed(() => {
    const id = this.projectId();
    return !!id && (this.teams.can(this.teamId(), Permission.MANAGE_PROJECTS, id) || this.teams.can(this.teamId(), Permission.MANAGE_ROLES, id));
  });
  readonly members = computed(() => this.teams.membersOf(this.teamId()));
  /** The projects directly below this view: the team's top level, or the sub-projects of the open project. */
  readonly children = computed(() => {
    const roots = this.teams.treeOf(this.teamId());
    const id = this.project()?.id;
    if (!id) return roots.map((n) => n.project);
    const find = (nodes: typeof roots): (typeof roots)[number] | undefined => {
      for (const n of nodes) {
        const hit = n.project.id === id ? n : find(n.children);
        if (hit) return hit;
      }
      return undefined;
    };
    return (find(roots)?.children ?? []).map((n) => n.project);
  });
  /** Notebooks of the team's or project's own space (read-only here: editing them comes with the content phases). */
  readonly notebooks = computed(() => {
    const space = this.project()?.spaceId ?? this.team()?.spaceId;
    return space ? this.tree.notebooks().filter((n) => n.spaceId === space && !n.deletedAt) : [];
  });

  constructor() {
    // Whenever the address changes, ask the server once whether it is real; keep what the local database holds if there is no network.
    effect(() => {
      const team = this.teamId();
      const project = this.projectId();
      if (this.teams.teams() === null) return;
      untracked(() => void this.verify(team, project));
    });
  }

  private async verify(team: string, project: string | undefined): Promise<void> {
    let ok = false;
    try {
      ok = this.teams.teamById().has(team)
        ? await this.teams.refreshTeam(team)
        : await this.teams.fetchTeam(team);
      if (ok && project) ok = this.teams.projectById().get(project)?.teamId === team;
    } catch {
      // Offline or the server is down: trust the local database.
      ok =
        this.teams.teamById().has(team) &&
        (!project || this.teams.projectById().get(project)?.teamId === team);
    }
    this.verified.set({ team, project, ok });
  }
}
