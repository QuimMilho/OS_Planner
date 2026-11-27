import { Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { Permission, positionBetween } from '@os-planner/shared/lite';
import { uuidv7 } from '../../core/ids';
import { toProblem } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { NavContext } from '../../core/nav-context';
import { Notify } from '../../core/notify';
import { AuthStore } from '../../core/auth-store';
import { BoardStore } from '../../data/board-store';
import { TeamStore } from '../../data/team-store';
import { Dialogs } from '../../shared/dialogs';
import { errKey } from './board-util';

interface Group {
  spaceId: string;
  /** Shown for a project's boards; null for the team's own and for a person's own. */
  title: string | null;
  canManage: boolean;
  boards: ReturnType<BoardStore['boardsOfSpace']>;
}

/** The boards of a space in its sidebar: a person's own, or a team's and then each project's under its name. */
@Component({
  selector: 'app-board-list',
  imports: [RouterLink, MatIconModule, TranslocoPipe],
  template: `
    <div data-board-list>
      @for (g of groups(); track g.spaceId) {
        @if (g.title) {
          <h4 class="proj" [attr.data-board-group]="g.title"><mat-icon>folder</mat-icon>{{ g.title }}</h4>
        }
        <div class="head" [class.sub]="!!g.title">
          <span>{{ 'board.title' | transloco }}</span>
          @if (g.canManage) {
            <button type="button" class="add" (click)="create(g.spaceId)" [attr.aria-label]="'board.new' | transloco" data-action="new-board">
              <mat-icon>add</mat-icon>
            </button>
          }
        </div>
        @for (b of g.boards; track b.id) {
          <a class="row" [routerLink]="['/app/b', b.id]" [class.active]="nav.url().startsWith('/app/b/' + b.id)" [class.archived]="!!b.archivedAt" [attr.data-board-row]="b.name">
            <mat-icon aria-hidden="true">{{ b.archivedAt ? 'inventory_2' : 'view_kanban' }}</mat-icon>
            <span class="label">{{ b.name }}</span>
          </a>
        } @empty {
          <p class="muted none">{{ (g.canManage ? 'board.noneManage' : 'board.none') | transloco }}</p>
        }
      }
    </div>
  `,
  styles: `
    .head,
    .proj {
      display: flex;
      align-items: center;
      gap: 6px;
      margin: 12px 8px 4px 16px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
    }
    .proj {
      margin-top: 14px;
      text-transform: none;
      letter-spacing: 0;
      font-size: 13px;
    }
    .proj mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
    }
    .head.sub {
      margin-left: 28px;
    }
    .head span {
      flex: 1;
    }
    .add {
      border: 0;
      background: none;
      color: var(--text-dim);
      cursor: pointer;
      width: 24px;
      height: 24px;
      display: grid;
      place-items: center;
      border-radius: 6px;
      padding: 0;
    }
    .add:hover {
      background: var(--surface-3);
    }
    .add mat-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 6px;
      padding: 0 8px 0 12px;
      min-height: 32px;
      border-radius: 8px;
      font-size: 14px;
      color: var(--text-dim);
      text-decoration: none;
    }
    .row:hover,
    .row.active {
      background: var(--surface-3);
      color: var(--text);
    }
    .row.archived {
      opacity: 0.6;
    }
    .row mat-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
      flex: none;
    }
    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .none {
      margin: 4px 16px;
      font-size: 13px;
    }
  `,
})
export class BoardList {
  /** The team whose boards to show (its own and its projects'); without it, the person's own. */
  readonly teamId = input<string | null>(null);

  protected readonly boards = inject(BoardStore);
  protected readonly nav = inject(NavContext);
  private readonly teams = inject(TeamStore);
  private readonly auth = inject(AuthStore);
  private readonly dialogs = inject(Dialogs);
  private readonly notify = inject(Notify);
  private readonly router = inject(Router);
  private readonly lang = inject(Language);

  protected readonly groups = computed<Group[]>(() => {
    const teamId = this.teamId();
    const spaces: { spaceId: string; title: string | null }[] = [];
    if (teamId) {
      const team = this.teams.teamById().get(teamId);
      if (!team) return [];
      spaces.push({ spaceId: team.spaceId, title: null });
      for (const p of this.teams.projects().filter((p) => p.teamId === teamId)) spaces.push({ spaceId: p.spaceId, title: p.name });
    } else {
      const own = this.auth.user()?.personalSpaceId;
      if (!own) return [];
      spaces.push({ spaceId: own, title: null });
    }
    const out: Group[] = [];
    for (const s of spaces) {
      const list = this.boards.boardsOfSpace(s.spaceId);
      const canManage = this.boards.canIn(s.spaceId, Permission.MANAGE_BOARDS);
      // a project with nothing to show and nothing the person can add is left out
      if (s.title && !list.length && !canManage) continue;
      out.push({ ...s, canManage, boards: [...list.filter((b) => !b.archivedAt), ...list.filter((b) => b.archivedAt)] });
    }
    return out;
  });

  protected async create(spaceId: string): Promise<void> {
    const answer = await this.dialogs.prompt({
      titleKey: 'board.new',
      labelKey: 'board.name',
      confirmKey: 'board.create',
      validate: (v) => (v.trim() ? null : 'board.nameRequired'),
    });
    if (answer?.action !== 'ok') return;
    try {
      // The first columns, in the person's language (the server would make English ones).
      let last: string | null = null;
      const columns = (['todo', 'doing', 'done'] as const).map((kind) => ({
        id: uuidv7(),
        name: this.lang.t(`board.col.${kind}`),
        kind,
        position: (last = positionBetween(last, null)),
      }));
      const board = await this.boards.createBoard(spaceId, { name: answer.value.trim(), columns });
      void this.router.navigate(['/app/b', board.id]);
    } catch (e) {
      this.notify.error(errKey(toProblem(e).code));
    }
  }
}
