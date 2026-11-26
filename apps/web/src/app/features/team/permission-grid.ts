import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  ALL_PERMISSIONS,
  PERMISSION_GROUPS,
  Permission,
  type PermissionName,
} from '@os-planner/shared/lite';
import { Language } from '../../core/i18n';

export interface GridValue {
  allow: bigint;
  deny: bigint;
}

type State = 'allow' | 'inherit' | 'deny';

/**
 * Every permission, grouped as in the team settings, with a search box and a one-line explanation under each.
 *
 *  - `check` mode: a role. One box per permission (`allow` is the value; `deny` is ignored).
 *  - `tri` mode: an overwrite, exactly like Discord's: allow (✓), inherit (–) or deny (✗) per permission.
 *
 * Only the permissions in `editable` can be changed (people can only hand out what they hold); the rest are shown but disabled.
 */
@Component({
  selector: 'app-permission-grid',
  imports: [FormsModule, MatIconModule, TranslocoPipe],
  template: `
    <div class="grid" data-permission-grid [attr.data-mode]="mode()">
      <label class="search">
        <mat-icon aria-hidden="true">search</mat-icon>
        <input
          type="search"
          name="permission-search"
          [ngModel]="query()"
          (ngModelChange)="query.set($event)"
          [placeholder]="'permissions.search' | transloco"
          [attr.aria-label]="'permissions.search' | transloco"
          autocomplete="off"
        />
      </label>

      @for (g of groups(); track g.id) {
        <section [attr.data-group]="g.id">
          <h4>{{ 'permissions.group.' + g.id | transloco }}</h4>
          @for (name of g.names; track name) {
            <div class="row" [attr.data-perm]="name" [class.locked]="!isEditable(name)">
              <div class="text">
                <span class="label">{{ 'permissions.' + name | transloco }}</span>
                <span class="hint">{{ 'permissions.hint.' + name | transloco }}</span>
              </div>
              @if (mode() === 'check') {
                <input
                  type="checkbox"
                  class="check"
                  [checked]="has(allow(), name)"
                  [disabled]="!isEditable(name)"
                  [attr.aria-label]="'permissions.' + name | transloco"
                  (change)="set(name, $any($event.target).checked ? 'allow' : 'inherit')"
                />
              } @else {
                <div
                  class="tri"
                  role="radiogroup"
                  [attr.aria-label]="'permissions.' + name | transloco"
                >
                  @for (s of states; track s) {
                    <button
                      type="button"
                      role="radio"
                      [class]="'t ' + s"
                      [attr.aria-checked]="stateOf(name) === s"
                      [attr.aria-label]="'overwrite.' + s | transloco"
                      [attr.title]="'overwrite.' + s | transloco"
                      [attr.data-set]="s"
                      [disabled]="!isEditable(name)"
                      (click)="set(name, s)"
                    >
                      <mat-icon aria-hidden="true">{{
                        s === 'allow' ? 'check' : s === 'deny' ? 'close' : 'remove'
                      }}</mat-icon>
                    </button>
                  }
                </div>
              }
            </div>
          }
        </section>
      } @empty {
        <p class="muted">{{ 'permissions.noMatch' | transloco }}</p>
      }
    </div>
  `,
  styles: `
    .search {
      display: flex;
      align-items: center;
      gap: 8px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0 10px;
      margin-bottom: 8px;
      background: var(--surface-2);
    }
    .search input {
      flex: 1;
      min-width: 0;
      height: 36px;
      border: 0;
      outline: 0;
      background: none;
      color: var(--text);
      font: inherit;
    }
    h4 {
      margin: 16px 0 4px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 4px;
      border-bottom: 1px solid var(--border);
    }
    .row.locked {
      opacity: 0.55;
    }
    .text {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .label {
      font-weight: 500;
    }
    .hint {
      font-size: 12px;
      color: var(--text-dim);
    }
    .check {
      width: 18px;
      height: 18px;
      accent-color: var(--accent);
    }
    .tri {
      display: inline-flex;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      flex: none;
    }
    .t {
      width: 34px;
      height: 30px;
      display: grid;
      place-items: center;
      border: 0;
      background: var(--surface-2);
      color: var(--text-dim);
      cursor: pointer;
      padding: 0;
    }
    .t + .t {
      border-left: 1px solid var(--border);
    }
    .t mat-icon {
      font-size: 18px;
      width: 18px;
      height: 18px;
    }
    .t:disabled {
      cursor: not-allowed;
    }
    .t[aria-checked='true'].allow {
      background: #2f9e44;
      color: #fff;
    }
    .t[aria-checked='true'].deny {
      background: var(--mat-sys-error, #b3261e);
      color: var(--mat-sys-on-error, #fff);
    }
    .t[aria-checked='true'].inherit {
      background: var(--surface-3);
      color: var(--text);
    }
  `,
})
export class PermissionGrid {
  readonly mode = input<'check' | 'tri'>('check');
  readonly allow = input(0n);
  readonly deny = input(0n);
  /** The permissions that may be changed. Default: all of them. */
  readonly editable = input<bigint>(ALL_PERMISSIONS);
  readonly changed = output<GridValue>();

  protected readonly states: State[] = ['allow', 'inherit', 'deny'];
  protected readonly query = signal('');
  private readonly lang = inject(Language);

  protected readonly groups = computed(() => {
    const q = this.query().trim().toLowerCase();
    return PERMISSION_GROUPS.map((g) => ({
      id: g.id,
      names: g.permissions.filter(
        (n) =>
          !q ||
          this.lang.t(`permissions.${n}`).toLowerCase().includes(q) ||
          this.lang.t(`permissions.hint.${n}`).toLowerCase().includes(q),
      ),
    })).filter((g) => g.names.length);
  });

  protected has(set: bigint, name: PermissionName): boolean {
    return (set & Permission[name]) !== 0n;
  }

  protected isEditable(name: PermissionName): boolean {
    return (this.editable() & Permission[name]) !== 0n;
  }

  protected stateOf(name: PermissionName): State {
    return this.has(this.allow(), name)
      ? 'allow'
      : this.has(this.deny(), name)
        ? 'deny'
        : 'inherit';
  }

  protected set(name: PermissionName, state: State): void {
    if (!this.isEditable(name)) return;
    const bit = Permission[name];
    this.changed.emit({
      allow: state === 'allow' ? this.allow() | bit : this.allow() & ~bit,
      deny: state === 'deny' ? this.deny() | bit : this.deny() & ~bit,
    });
  }
}
