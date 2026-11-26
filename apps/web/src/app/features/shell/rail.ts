import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslocoPipe } from '@jsverse/transloco';
import type { TeamDto } from '@os-planner/shared';
import { NavContext } from '../../core/nav-context';
import { TeamStore } from '../../data/team-store';

/** The narrow strip on the left, like Discord's: your own notes, then one button per team. */
@Component({
  selector: 'app-rail',
  imports: [RouterLink, RouterLinkActive, MatIconModule, MatTooltipModule, TranslocoPipe],
  template: `
    <nav class="rail" [attr.aria-label]="'rail.label' | transloco">
      <a
        class="item home"
        routerLink="/app"
        [class.on]="!nav.teamId()"
        data-rail="home"
        [matTooltip]="'rail.home' | transloco"
        matTooltipPosition="right"
        [attr.aria-label]="'rail.home' | transloco"
      >
        <mat-icon>home</mat-icon>
      </a>
      @if ((teams.teams() ?? []).length) {
        <span class="sep" aria-hidden="true"></span>
      }
      @for (t of teams.teams() ?? []; track t.id) {
        <a
          class="item team"
          [routerLink]="['/app/t', t.id]"
          [class.on]="nav.teamId() === t.id"
          [style.background]="t.color"
          [attr.data-team]="t.name"
          [matTooltip]="t.name"
          matTooltipPosition="right"
          [attr.aria-label]="t.name"
        >
          {{ initial(t) }}
          @if (teams.pendingRequests(t.id) > 0) {
            <span class="badge" [attr.data-rail-badge]="t.name">{{ teams.pendingRequests(t.id) }}</span>
          }
        </a>
      }
      <span class="sep" aria-hidden="true"></span>
      <a
        class="item browse"
        routerLink="/app/directory"
        routerLinkActive="on"
        data-rail="directory"
        [matTooltip]="'rail.browse' | transloco"
        matTooltipPosition="right"
        [attr.aria-label]="'rail.browse' | transloco"
      >
        <mat-icon>explore</mat-icon>
      </a>
    </nav>
  `,
  styles: `
    :host {
      display: block;
      flex: none;
    }
    .rail {
      width: 60px;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 10px 0;
      background: var(--surface-3);
      border-right: 1px solid var(--border);
      overflow-y: auto;
    }
    .item {
      position: relative;
      display: grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border-radius: 50%;
      background: var(--surface-2);
      color: var(--text);
      text-decoration: none;
      font-weight: 700;
      font-size: 17px;
      transition:
        border-radius 0.12s,
        background 0.12s;
    }
    .item:hover,
    .item.on {
      border-radius: 14px;
    }
    .item.on {
      background: var(--accent);
      color: var(--mat-sys-on-primary);
    }
    .item.on::before {
      content: '';
      position: absolute;
      left: -9px;
      top: 9px;
      width: 4px;
      height: 24px;
      border-radius: 0 4px 4px 0;
      background: var(--accent);
    }
    .item.team {
      color: #fff;
      background: color-mix(in srgb, var(--accent) 55%, var(--surface-2));
    }
    .item:focus-visible {
      outline: 3px solid var(--accent);
      outline-offset: 2px;
    }
    .sep {
      width: 28px;
      height: 2px;
      border-radius: 1px;
      background: var(--border);
    }
    mat-icon {
      color: inherit;
    }
    .badge {
      position: absolute;
      right: -4px;
      bottom: -4px;
      min-width: 18px;
      padding: 0 5px;
      border-radius: 9px;
      background: var(--mat-sys-error);
      color: var(--mat-sys-on-error);
      font-size: 11px;
      line-height: 18px;
      text-align: center;
    }
  `,
})
export class Rail {
  readonly teams = inject(TeamStore);
  readonly nav = inject(NavContext);

  /** The first letter of the team name, for teams that have no icon of their own. */
  initial(t: TeamDto): string {
    return (t.name.trim().charAt(0) || '?').toUpperCase();
  }
}
