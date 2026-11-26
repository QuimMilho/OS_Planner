import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { PERMISSION_GROUPS, type PermissionName, type Reason } from '@os-planner/shared/lite';
import type { PreviewDto, RoleDto } from '@os-planner/shared';
import type { ApiProblem } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { RolesStore } from '../../data/roles-store';
import { TeamStore } from '../../data/team-store';
import { roleErrorKey } from './roles-editor';

/**
 * "View as": pick a role or a member and see what they can do here, permission by permission, with the rule that decided
 * it (which role, which overwrite on which project). It runs the server's own engine, so an administrator can find out why
 * a control is disabled for someone.
 */
@Component({
  selector: 'app-view-as',
  imports: [FormsModule, MatIconModule, TranslocoPipe],
  template: `
    <div data-view-as>
      <label class="pick">
        <span>{{ 'viewAs.pick' | transloco }}</span>
        <select name="view-as-subject" [ngModel]="subject()" (ngModelChange)="choose($event)">
          <option value="">{{ 'viewAs.choose' | transloco }}</option>
          <optgroup [label]="'viewAs.roles' | transloco">
            @for (r of roles(); track r.id) {
              <option [value]="'role:' + r.id">{{ r.name }}</option>
            }
          </optgroup>
          <optgroup [label]="'viewAs.members' | transloco">
            @for (m of members(); track m.userId) {
              <option [value]="'member:' + m.userId">{{ m.nickname || m.displayName }}</option>
            }
          </optgroup>
        </select>
      </label>

      @if (result(); as r) {
        <p class="muted summary" data-view-as-summary>
          {{ 'viewAs.summary' | transloco: { name: r.subject.name, count: grantedCount() } }}
        </p>
        @for (g of groups; track g.id) {
          <h4>{{ 'permissions.group.' + g.id | transloco }}</h4>
          @for (name of g.permissions; track name) {
            @let d = decision(name);
            <div class="row" [attr.data-view-as-perm]="name" [attr.data-granted]="d.granted">
              <mat-icon class="mark" [class.yes]="d.granted" aria-hidden="true">{{
                d.granted ? 'check_circle' : 'cancel'
              }}</mat-icon>
              <span class="label">{{ 'permissions.' + name | transloco }}</span>
              <span class="reason" data-reason>{{ reasonText(d.reason, r) }}</span>
            </div>
          }
        }
      }
    </div>
  `,
  styles: `
    .pick {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 13px;
      color: var(--text-dim);
      max-width: 340px;
    }
    select {
      height: 38px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface-2);
      color: var(--text);
      padding: 0 8px;
      font: inherit;
    }
    .summary {
      margin: 12px 0 0;
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
      gap: 10px;
      padding: 5px 4px;
      border-bottom: 1px solid var(--border);
    }
    .mark {
      color: var(--mat-sys-error, #b3261e);
      font-size: 20px;
      width: 20px;
      height: 20px;
      flex: none;
    }
    .mark.yes {
      color: #2f9e44;
    }
    .label {
      flex: 1;
      min-width: 0;
    }
    .reason {
      font-size: 13px;
      color: var(--text-dim);
      text-align: right;
    }
  `,
})
export class ViewAs {
  /** What to look at: the team, or one of its projects. */
  readonly where = input.required<{ kind: 'team' | 'project'; id: string }>();
  readonly roles = input.required<readonly RoleDto[]>();
  readonly teamId = input.required<string>();

  private readonly store = inject(RolesStore);
  private readonly teams = inject(TeamStore);
  private readonly notify = inject(Notify);

  protected readonly groups = PERMISSION_GROUPS;
  protected readonly subject = signal('');
  protected readonly result = signal<PreviewDto | null>(null);
  protected readonly members = computed(() => this.teams.membersOf(this.teamId()));
  protected readonly grantedCount = computed(
    () => this.result()?.decisions.filter((d) => d.granted).length ?? 0,
  );

  protected async choose(value: string): Promise<void> {
    this.subject.set(value);
    if (!value) return void this.result.set(null);
    const [kind, id] = value.split(':') as ['role' | 'member', string];
    try {
      this.result.set(await this.store.preview({ kind, id }, this.where()));
    } catch (e) {
      this.result.set(null);
      this.notify.error(roleErrorKey(e as ApiProblem));
    }
  }

  protected decision(name: PermissionName) {
    return this.result()!.decisions.find((d) => d.permission === name)!;
  }

  /** The rule that decided, in words: "Role Dev", "@everyone denied on Apollo", ... */
  protected reasonText(reason: Reason, r: PreviewDto): string {
    const nameOf = (id: string) => r.names[id] ?? '?';
    const list = (ids: string[]) => ids.map(nameOf).join(', ');
    const t = (key: string, params?: Record<string, unknown>) => this.i18n(key, params);
    switch (reason.kind) {
      case 'owner':
        return t('viewAs.reason.owner');
      case 'administrator':
        return reason.roleIds.length
          ? t('viewAs.reason.administratorRole', { roles: list(reason.roleIds) })
          : t('viewAs.reason.administratorEveryone');
      case 'base': {
        const parts = [...(reason.everyone ? ['@everyone'] : []), ...reason.roleIds.map(nameOf)];
        return t('viewAs.reason.base', { from: parts.join(', ') });
      }
      case 'overwrite': {
        const who =
          reason.subject === 'everyone'
            ? '@everyone'
            : reason.subject === 'member'
              ? t('viewAs.reason.member')
              : list(reason.roleIds);
        const where = reason.level ? nameOf(reason.level) : '';
        return t(reason.effect === 'allow' ? 'viewAs.reason.allowed' : 'viewAs.reason.denied', {
          who,
          where,
        });
      }
      case 'masked':
        return t('viewAs.reason.masked', { missing: t(`permissions.${reason.missing}`) });
      default:
        return t('viewAs.reason.none');
    }
  }

  private readonly lang = inject(Language);
  private i18n(key: string, params?: Record<string, unknown>): string {
    return this.lang.t(key, params);
  }
}
