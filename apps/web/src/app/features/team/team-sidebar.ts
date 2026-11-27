import { Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { openNotifyDialog } from '../notifications/notify-dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ProjectDto } from '@os-planner/shared';
import { NavContext } from '../../core/nav-context';
import { TeamStore, type ProjectNode } from '../../data/team-store';
import { BoardList } from '../boards/board-list';
import { ChannelList } from '../chat/channel-list';
import { Tree } from '../shell/tree';
import { TeamUi } from './team-ui';

/** One level of the project tree; it renders itself for the children. */
@Component({
  selector: 'app-project-rows',
  imports: [RouterLink, MatIconModule, MatButtonModule, MatMenuModule, TranslocoPipe],
  template: `
    @for (n of nodes(); track n.project.id) {
      <div
        class="row"
        [class.active]="
          nav.route().projectId === n.project.id || selectedSpace() === n.project.spaceId
        "
        [class.archived]="!!n.project.archivedAt"
        [class.drop]="ui.dropTarget() === n.project.id"
        [attr.data-project]="n.project.name"
        [style.padding-left.px]="8 + depth() * 16"
        [attr.draggable]="manage() ? 'true' : null"
        (dragstart)="onDragStart($event, n.project)"
        (dragend)="ui.dragging.set(null); ui.dropTarget.set(null)"
        (dragover)="onDragOver($event, n.project.id)"
        (dragleave)="ui.dropTarget() === n.project.id && ui.dropTarget.set(null)"
        (drop)="$event.preventDefault(); $event.stopPropagation(); ui.drop(n.project.id)"
      >
        @if (n.children.length) {
          <button
            type="button"
            class="tog"
            (click)="ui.toggle(n.project.id)"
            [attr.aria-expanded]="ui.isOpen(n.project.id)"
            [attr.aria-label]="n.project.name"
          >
            <mat-icon>{{ ui.isOpen(n.project.id) ? 'expand_more' : 'chevron_right' }}</mat-icon>
          </button>
        } @else {
          <span class="tog"></span>
        }
        <a class="name" [routerLink]="['/app/t', n.project.teamId, 'p', n.project.id]">
          <mat-icon aria-hidden="true">{{
            n.project.archivedAt ? 'inventory_2' : 'folder'
          }}</mat-icon>
          <span class="label">{{ n.project.name }}</span>
        </a>
        @if (manage()) {
          <button
            type="button"
            class="act"
            [matMenuTriggerFor]="menu"
            [attr.aria-label]="'project.actions' | transloco"
            data-project-menu
          >
            <mat-icon>more_horiz</mat-icon>
          </button>
          <mat-menu #menu="matMenu">
            <button
              mat-menu-item
              type="button"
              (click)="ui.newProject(n.project.teamId, n.project.id)"
              data-action="new-sub"
            >
              <mat-icon>create_new_folder</mat-icon>{{ 'project.newSub' | transloco }}
            </button>
            <button mat-menu-item type="button" (click)="ui.rename(n.project)" data-action="rename">
              <mat-icon>edit</mat-icon>{{ 'project.rename' | transloco }}
            </button>
            <button mat-menu-item type="button" (click)="ui.move(n.project)" data-action="move">
              <mat-icon>drive_file_move</mat-icon>{{ 'project.moveTo' | transloco }}
            </button>
            <button
              mat-menu-item
              type="button"
              (click)="ui.archive(n.project)"
              data-action="archive"
            >
              <mat-icon>{{ n.project.archivedAt ? 'unarchive' : 'archive' }}</mat-icon>{{
                (n.project.archivedAt ? 'project.unarchive' : 'project.archive') | transloco
              }}
            </button>
            <button mat-menu-item type="button" (click)="ui.remove(n.project)" data-action="delete">
              <mat-icon>delete</mat-icon>{{ 'common.delete' | transloco }}
            </button>
          </mat-menu>
        }
      </div>
      @if (n.children.length && ui.isOpen(n.project.id)) {
        <app-project-rows [nodes]="n.children" [depth]="depth() + 1" [manage]="manage()" />
      }
    }
  `,
  styles: `
    :host {
      display: contents;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 2px;
      margin: 0 6px;
      padding-right: 4px;
      min-height: 34px;
      border-radius: 8px;
      font-size: 14px;
      border: 1px solid transparent;
    }
    .row:hover,
    .row.active {
      background: var(--surface-3);
    }
    .row.active {
      font-weight: 600;
    }
    .row.archived {
      opacity: 0.6;
    }
    .row.drop {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 14%, transparent);
    }
    .tog {
      width: 24px;
      height: 24px;
      flex: none;
      display: grid;
      place-items: center;
      border: 0;
      background: none;
      color: var(--text-dim);
      padding: 0;
      cursor: pointer;
      border-radius: 6px;
    }
    .tog mat-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;
    }
    .name {
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text);
      text-decoration: none;
      padding: 6px 0;
    }
    .name mat-icon {
      font-size: 20px;
      width: 20px;
      height: 20px;
      color: var(--text-dim);
      flex: none;
    }
    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .act {
      border: 0;
      background: none;
      color: var(--text-dim);
      cursor: pointer;
      border-radius: 6px;
      width: 28px;
      height: 28px;
      display: grid;
      place-items: center;
      padding: 0;
      opacity: 0;
    }
    .row:hover .act,
    .row:focus-within .act,
    .act:focus-visible {
      opacity: 1;
    }
    @media (hover: none) {
      .act {
        opacity: 1;
      }
    }
  `,
})
export class ProjectRows {
  readonly nodes = input.required<ProjectNode[]>();
  readonly depth = input(0);
  readonly manage = input(false);
  readonly ui = inject(TeamUi);
  readonly nav = inject(NavContext);

  /** Highlights the project whose page is open (a page belongs to a project's space). */
  readonly selectedSpace = computed(() => this.nav.place()?.projects.at(-1)?.spaceId ?? null);

  onDragStart(event: DragEvent, project: ProjectDto): void {
    if (!this.manage()) return;
    this.ui.dragging.set(project);
    event.dataTransfer?.setData('text/plain', project.name);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  onDragOver(event: DragEvent, id: string): void {
    if (!this.ui.canDropOn(id)) return;
    event.preventDefault(); // allows the drop
    event.stopPropagation();
    this.ui.dropTarget.set(id);
  }
}

/** The left column while inside a team: the team's name and its project tree, with the other kinds of things to come. */
@Component({
  selector: 'app-team-sidebar',
  imports: [RouterLink, MatIconModule, MatButtonModule, TranslocoPipe, ProjectRows, ChannelList, BoardList, Tree],
  template: `
    @if (team(); as t) {
      <section class="team" data-team-sidebar>
        <header>
          <a class="title" [routerLink]="['/app/t', t.id]" [title]="t.name">{{ t.name }}</a>
          <button mat-icon-button type="button" (click)="notifySettings(t)" [attr.aria-label]="'notif.open' | transloco" data-action="team-notifications">
            <mat-icon>notifications</mat-icon>
          </button>
          <a mat-icon-button [routerLink]="['/app/t', t.id, 'settings']" [attr.aria-label]="'team.settings' | transloco" data-action="team-settings-link">
            <mat-icon>settings</mat-icon>
          </a>
          @if (manage()) {
            <button
              mat-icon-button
              type="button"
              (click)="ui.newProject(t.id, null)"
              [attr.aria-label]="'project.new' | transloco"
              data-action="new-project"
            >
              <mat-icon>add</mat-icon>
            </button>
          }
        </header>

        <h3>{{ 'team.projects' | transloco }}</h3>
        <div
          class="tree"
          (dragover)="onTopOver($event)"
          (dragleave)="ui.dropTarget.set(null)"
          (drop)="$event.preventDefault(); ui.drop(null)"
          [class.drop]="ui.dropTarget() === 'top'"
          data-project-tree
        >
          <app-project-rows [nodes]="nodes()" [manage]="manage()" />
          @if (!nodes().length) {
            <p class="muted empty">{{ 'team.noProjects' | transloco }}</p>
          }
        </div>

        <h3 data-section="team-notebooks">{{ 'team.notebooks' | transloco }}</h3>
        <app-tree [spaceId]="t.spaceId" />
        @if (project(); as p) {
          <h3 class="project" data-section="project-notebooks">{{ p.name }}</h3>
          <app-tree [spaceId]="p.spaceId" />
        }
        <app-channel-list [teamId]="t.id" />
        <app-board-list [teamId]="t.id" />
        <a class="cal-link" routerLink="/app/calendar" [queryParams]="{ space: project()?.spaceId ?? t.spaceId }" data-team-calendar><mat-icon>calendar_month</mat-icon>{{ 'nav.calendar' | transloco }}</a>
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    header {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px 4px 16px;
    }
    .title {
      flex: 1;
      min-width: 0;
      font-weight: 700;
      font-size: 16px;
      color: var(--text);
      text-decoration: none;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cal-link {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 10px 8px 0;
      padding: 6px 8px;
      border-radius: 8px;
      color: var(--text);
      text-decoration: none;
    }
    .cal-link:hover {
      background: var(--surface-3);
    }
    h3 {
      margin: 14px 16px 4px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-dim);
    }
    h3.project {
      text-transform: none;
      letter-spacing: 0;
      margin-top: 8px;
    }
    .tree {
      min-height: 40px;
      padding-bottom: 8px;
      border-radius: 8px;
      margin: 0 4px;
    }
    .tree.drop {
      outline: 2px dashed var(--accent);
      outline-offset: -2px;
    }
    .empty {
      margin: 4px 16px;
      font-size: 13px;
    }
  `,
})
export class TeamSidebar {
  readonly nav = inject(NavContext);
  readonly ui = inject(TeamUi);
  private readonly teams = inject(TeamStore);
  private readonly dialog = inject(MatDialog);

  notifySettings(t: { id: string; name: string }): void {
    openNotifyDialog(this.dialog, { scope: { scopeKind: 'team', scopeId: t.id }, title: t.name });
  }

  onTopOver(event: DragEvent): void {
    if (!this.ui.canDropOn(null)) return;
    event.preventDefault();
    this.ui.dropTarget.set('top');
  }

  readonly team = computed(() => {
    const id = this.nav.teamId();
    return id ? (this.teams.teamById().get(id) ?? null) : null;
  });
  /** The project (or sub-project) the person is looking at: its notebooks are listed below the team's. */
  readonly project = computed(() => this.nav.place()?.projects.at(-1) ?? null);
  readonly nodes = computed(() => {
    const id = this.nav.teamId();
    this.teams.projects(); // re-run when projects change
    return id ? this.teams.treeOf(id) : [];
  });
  readonly manage = computed(() => {
    const id = this.nav.teamId();
    this.teams.members(); // permissions arrive together with members
    return id ? this.ui.canManage(id) : false;
  });
}
