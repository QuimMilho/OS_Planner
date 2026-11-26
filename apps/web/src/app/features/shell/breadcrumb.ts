import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { NavContext } from '../../core/nav-context';

/** `Team / Project / Sub-project` in the header, each crumb linking to its level. Nothing for personal notes. */
@Component({
  selector: 'app-breadcrumb',
  imports: [RouterLink, MatIconModule, TranslocoPipe],
  template: `
    @if (nav.crumbs().length) {
      <nav class="crumbs" [attr.aria-label]="'breadcrumb.label' | transloco" data-breadcrumb>
        <mat-icon aria-hidden="true">groups</mat-icon>
        @for (c of nav.crumbs(); track $index; let last = $last) {
          <a [routerLink]="c.link" [attr.aria-current]="last ? 'page' : null">{{ c.label }}</a>
          @if (!last) {
            <span class="sep" aria-hidden="true">/</span>
          }
        }
      </nav>
    }
  `,
  styles: `
    :host {
      min-width: 0;
    }
    .crumbs {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 14px;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
    }
    a {
      color: var(--text);
      text-decoration: none;
      overflow: hidden;
      text-overflow: ellipsis;
      padding: 2px 4px;
      border-radius: 6px;
    }
    a:hover {
      background: var(--surface-3);
    }
    a[aria-current='page'] {
      font-weight: 600;
    }
    .sep {
      color: var(--text-dim);
    }
    mat-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
      color: var(--text-dim);
      flex: none;
    }
    @media (max-width: 640px) {
      mat-icon {
        display: none;
      }
    }
  `,
})
export class Breadcrumb {
  readonly nav = inject(NavContext);
}
