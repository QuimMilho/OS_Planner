import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { checkRoleAction, permissionsFromString } from '@os-planner/shared/lite';
import type { InviteDto, RoleDto } from '@os-planner/shared';
import { toProblem } from '../../core/auth-store';
import { Notify } from '../../core/notify';
import { MembershipStore } from '../../data/membership-store';
import { RolesStore } from '../../data/roles-store';
import { Dialogs } from '../../shared/dialogs';

const KNOWN = new Set([
  'invalid_role',
  'project_must_be_top_level',
  'role_at_or_above',
  'permission_not_held',
  'missing_manage_roles',
  'forbidden',
  'invite_closed',
  'not_an_email_invite',
]);

/** The text for a failed invite request. */
export const inviteErrorKey = (e: unknown): string => {
  const code = toProblem(e).code;
  return KNOWN.has(code)
    ? `invite.err.${code}`
    : code === 'offline'
      ? 'errors.offline'
      : 'errors.generic';
};

const EXPIRY_CHOICES = [1, 7, 14, 30, 90] as const;
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Invitations of a team: links to share, invitations to email addresses, and the list of what is open or used. */
@Component({
  selector: 'app-invites-tab',
  imports: [FormsModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <div data-invites-tab>
      @if (assignable().length) {
        <fieldset class="roles">
          <legend>{{ 'invite.roles' | transloco }}</legend>
          @for (r of assignable(); track r.id) {
            <label class="pick" [attr.data-role-pick]="r.name">
              <input type="checkbox" [checked]="picked().has(r.id)" (change)="toggle(r.id)" />
              <span class="dot" [style.background]="r.color ?? 'var(--text-dim)'"></span
              >{{ r.name }}
            </label>
          }
        </fieldset>
      }

      <section class="card">
        <h3>{{ 'invite.linkTitle' | transloco }}</h3>
        <p class="muted">{{ 'invite.linkHint' | transloco }}</p>
        <div class="row">
          <label>
            {{ 'invite.expires' | transloco }}
            <select name="linkDays" [(ngModel)]="linkDays" data-field="link-days">
              @for (d of choices; track d) {
                <option [ngValue]="d">{{ 'invite.days' | transloco: { count: d } }}</option>
              }
            </select>
          </label>
          <label>
            {{ 'invite.maxUses' | transloco }}
            <input
              type="number"
              min="1"
              max="10000"
              name="maxUses"
              [(ngModel)]="maxUses"
              [placeholder]="'invite.unlimited' | transloco"
              data-field="max-uses"
            />
          </label>
          <button
            mat-flat-button
            type="button"
            [disabled]="busy()"
            (click)="createLink()"
            data-action="create-link"
          >
            {{ 'invite.createLink' | transloco }}
          </button>
        </div>
        @if (fresh()) {
          <div class="fresh" data-fresh-link>
            <p>{{ 'invite.linkCreated' | transloco }}</p>
            <div class="row">
              <input
                class="url"
                readonly
                [value]="fresh()"
                (focus)="$any($event.target).select()"
                data-invite-url
              />
              <button mat-stroked-button type="button" (click)="copy()" data-action="copy-link">
                <mat-icon>content_copy</mat-icon>{{ 'invite.copy' | transloco }}
              </button>
            </div>
          </div>
        }
      </section>

      <section class="card">
        <h3>{{ 'invite.emailTitle' | transloco }}</h3>
        <p class="muted">{{ 'invite.emailHint' | transloco }}</p>
        <label class="block">
          {{ 'invite.emailLabel' | transloco }}
          <textarea
            rows="3"
            name="addresses"
            [(ngModel)]="addresses"
            [placeholder]="'invite.emailPlaceholder' | transloco"
            data-field="addresses"
          ></textarea>
        </label>
        <div class="row">
          <button
            mat-flat-button
            type="button"
            [disabled]="busy() || !addresses.trim()"
            (click)="sendEmails()"
            data-action="send-invites"
          >
            {{ 'invite.sendEmails' | transloco }}
          </button>
        </div>
      </section>

      <h3>{{ 'invite.list' | transloco }}</h3>
      @if (!invites().length) {
        <p class="muted" data-no-invites>{{ 'invite.none' | transloco }}</p>
      }
      <ul class="list">
        @for (i of invites(); track i.id) {
          <li [attr.data-invite]="i.email ?? 'link'" [attr.data-status]="i.status">
            <mat-icon>{{ i.kind === 'link' ? 'link' : 'mail' }}</mat-icon>
            <span class="what">
              <span class="n">{{ i.email ?? ('invite.kindLink' | transloco) }}</span>
              <span class="muted small">
                @if (i.invitedBy) {
                  {{ 'invite.by' | transloco: { name: i.invitedBy.displayName } }} ·
                }
                @if (i.kind === 'link') {
                  {{
                    (i.maxUses ? 'invite.usesOf' : 'invite.uses')
                      | transloco: { used: i.uses, max: i.maxUses }
                  }}
                  ·
                }
                {{ 'invite.expiresOn' | transloco: { date: day(i.expiresAt) } }}
              </span>
            </span>
            <span class="status" [attr.data-badge]="i.status">{{
              'invite.status.' + i.status | transloco
            }}</span>
            @if (i.status === 'active') {
              @if (i.kind === 'email') {
                <button mat-button type="button" (click)="resend(i)" data-action="resend">
                  {{ 'invite.resend' | transloco }}
                </button>
              }
              <button mat-button type="button" (click)="revoke(i)" data-action="revoke">
                {{ 'invite.revoke' | transloco }}
              </button>
            }
          </li>
        }
      </ul>
    </div>
  `,
  styles: `
    .card {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
      margin: 0 0 16px;
    }
    h3 {
      margin: 0 0 4px;
      font-size: 15px;
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: flex-end;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 13px;
      color: var(--text-dim);
    }
    label.block {
      margin: 8px 0;
    }
    select,
    input[type='number'],
    textarea,
    .url {
      font: inherit;
      padding: 6px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface-2);
      color: var(--text);
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      resize: vertical;
    }
    .url {
      flex: 1;
      min-width: 260px;
    }
    .fresh {
      margin-top: 12px;
      padding: 10px 12px;
      border-radius: 8px;
      background: var(--surface-3);
    }
    .fresh p {
      margin: 0 0 8px;
    }
    .roles {
      border: 1px solid var(--border);
      border-radius: 10px;
      margin: 0 0 16px;
      padding: 8px 14px 10px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px 16px;
    }
    .roles legend {
      font-size: 13px;
      color: var(--text-dim);
      padding: 0 6px;
    }
    .pick {
      flex-direction: row;
      align-items: center;
      gap: 6px;
      color: var(--text);
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
    }
    .list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .list li {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 4px;
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .what {
      flex: 1;
      min-width: 180px;
      display: flex;
      flex-direction: column;
      overflow-wrap: anywhere;
    }
    .small {
      font-size: 12px;
    }
    .status {
      font-size: 12px;
      padding: 1px 8px;
      border-radius: 10px;
      background: var(--surface-3);
      color: var(--text-dim);
    }
    .status[data-badge='active'] {
      color: var(--text);
      background: color-mix(in srgb, var(--accent) 25%, var(--surface-3));
    }
  `,
})
export class InvitesTab {
  readonly teamId = input.required<string>();

  private readonly store = inject(MembershipStore);
  private readonly roleStore = inject(RolesStore);
  private readonly notify = inject(Notify);
  private readonly dialogs = inject(Dialogs);

  protected readonly choices = EXPIRY_CHOICES;
  protected linkDays: number = 7;
  protected maxUses: number | null = null;
  protected addresses = '';

  protected readonly invites = signal<InviteDto[]>([]);
  protected readonly busy = signal(false);
  protected readonly fresh = signal('');
  protected readonly picked = signal<ReadonlySet<string>>(new Set());
  private readonly roles = signal<RoleDto[]>([]);

  /** The roles the person may put on an invitation: the same ones they could give by hand. */
  protected readonly assignable = computed(() => {
    const actor = this.roleStore.actor({ kind: 'team', id: this.teamId() }, this.roles());
    return this.roles()
      .filter(
        (r) =>
          !r.isEveryone &&
          r.projectId === null &&
          checkRoleAction(actor, 'assign', {
            position: r.position,
            isEveryone: r.isEveryone,
            permissions: permissionsFromString(r.permissions) ?? 0n,
          }) === null,
      )
      .sort((a, b) => b.position - a.position);
  });

  constructor() {
    effect(() => {
      const id = this.teamId();
      untracked(() => void this.load(id));
    });
  }

  private async load(teamId: string): Promise<void> {
    try {
      const [invites, roles] = await Promise.all([
        this.store.invites(teamId),
        this.roleStore.roles({ kind: 'team', id: teamId }).catch(() => [] as RoleDto[]),
      ]);
      this.invites.set(invites);
      this.roles.set(roles);
    } catch (e) {
      this.notify.error(inviteErrorKey(e));
    }
  }

  protected day(iso: string): string {
    return new Date(iso).toLocaleDateString();
  }

  protected toggle(id: string): void {
    const next = new Set(this.picked());
    if (!next.delete(id)) next.add(id);
    this.picked.set(next);
  }

  private roleIds(): string[] {
    const allowed = new Set(this.assignable().map((r) => r.id));
    return [...this.picked()].filter((id) => allowed.has(id));
  }

  protected async createLink(): Promise<void> {
    this.busy.set(true);
    try {
      const made = await this.store.createInvite(this.teamId(), {
        link: true,
        roleIds: this.roleIds(),
        expiresInDays: this.linkDays,
        ...(this.maxUses ? { maxUses: this.maxUses } : {}),
      });
      this.fresh.set(made.url ?? '');
      await this.load(this.teamId());
    } catch (e) {
      this.notify.error(inviteErrorKey(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.fresh());
      this.notify.info('invite.copied');
    } catch {
      /* the field is selectable: the person can copy it by hand */
    }
  }

  protected async sendEmails(): Promise<void> {
    const wanted = [
      ...new Set(
        this.addresses
          .split(/[\s,;]+/)
          .map((a) => a.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    const bad = wanted.filter((a) => !ADDRESS.test(a));
    if (bad.length) return this.notify.error('invite.badAddress', { address: bad[0] });
    this.busy.set(true);
    let sent = 0;
    try {
      for (const email of wanted) {
        await this.store.createInvite(this.teamId(), { email, roleIds: this.roleIds() });
        sent++;
      }
      this.addresses = '';
      this.notify.info('invite.sent', { count: sent });
    } catch (e) {
      this.notify.error(inviteErrorKey(e));
    } finally {
      this.busy.set(false);
      await this.load(this.teamId());
    }
  }

  protected async revoke(i: InviteDto): Promise<void> {
    const ok = await this.dialogs.confirm({
      titleKey: 'invite.revokeTitle',
      messageKey: 'invite.revokeText',
      params: { what: i.email ?? '' },
      confirmKey: 'invite.revoke',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.store.revokeInvite(i.id);
      await this.load(this.teamId());
    } catch (e) {
      this.notify.error(inviteErrorKey(e));
    }
  }

  protected async resend(i: InviteDto): Promise<void> {
    try {
      await this.store.resendInvite(i.id);
      this.notify.info('invite.resent', { email: i.email });
      await this.load(this.teamId());
    } catch (e) {
      this.notify.error(inviteErrorKey(e));
    }
  }
}
