import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import type { BanDto, JoinRequestDto, JoinPolicy } from '@os-planner/shared';
import { toProblem } from '../../core/auth-store';
import { Notify } from '../../core/notify';
import { MembershipStore } from '../../data/membership-store';
import { TeamStore } from '../../data/team-store';

/** The text for a failed request in these tabs. */
export const accessErrorKey = (e: unknown): string => {
  const code = toProblem(e).code;
  if (code === 'quota_exceeded') return 'invite.err.quota_exceeded';
  if (code === 'role_at_or_above') return 'roles.err.role_at_or_above';
  if (code === 'banned') return 'join.err.banned';
  return code === 'offline' ? 'errors.offline' : 'errors.generic';
};

const LIST_STYLES = `
  .list { list-style: none; margin: 0; padding: 0; }
  .list li { display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .who { flex: 1; min-width: 180px; display: flex; flex-direction: column; overflow-wrap: anywhere; }
  .small { font-size: 12px; }
  .msg { font-style: italic; }
`;

// ---------------------------------------------------------------- requests

/** People asking to join a team that works by request. Deciding needs "Manage members". */
@Component({
  selector: 'app-requests-tab',
  imports: [MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <div data-requests-tab>
      @if (loaded() && !items().length) {
        <p class="muted" data-no-requests>{{ 'requests.none' | transloco }}</p>
      }
      <ul class="list">
        @for (r of items(); track r.id) {
          <li [attr.data-request]="r.displayName">
            <mat-icon>person_add</mat-icon>
            <span class="who">
              <span>{{ r.displayName }}</span>
              @if (r.message) {
                <span class="muted small msg">“{{ r.message }}”</span>
              }
              <span class="muted small">{{ date(r.createdAt) }}</span>
            </span>
            <button mat-flat-button type="button" (click)="decide(r, true)" data-action="approve">
              {{ 'requests.approve' | transloco }}
            </button>
            <button mat-stroked-button type="button" (click)="decide(r, false)" data-action="deny">
              {{ 'requests.deny' | transloco }}
            </button>
          </li>
        }
      </ul>
    </div>
  `,
  styles: LIST_STYLES,
})
export class RequestsTab {
  readonly teamId = input.required<string>();
  private readonly store = inject(MembershipStore);
  private readonly notify = inject(Notify);

  protected readonly items = signal<JoinRequestDto[]>([]);
  protected readonly loaded = signal(false);

  constructor() {
    effect(() => {
      const id = this.teamId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string): Promise<void> {
    try {
      this.items.set(await this.store.requests(id));
      this.loaded.set(true);
    } catch (e) {
      this.notify.error(accessErrorKey(e));
    }
  }

  protected date(iso: string): string {
    return new Date(iso).toLocaleDateString();
  }

  protected async decide(r: JoinRequestDto, approve: boolean): Promise<void> {
    try {
      await this.store.decide(this.teamId(), r.id, approve);
      this.notify.info(approve ? 'requests.approved' : 'requests.denied', { name: r.displayName });
    } catch (e) {
      this.notify.error(accessErrorKey(e));
    }
    await this.load(this.teamId());
  }
}

// ---------------------------------------------------------------- bans

/** People the team does not let in. Lifting a ban lets them use any way in again. */
@Component({
  selector: 'app-bans-tab',
  imports: [MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <div data-bans-tab>
      <p class="muted">{{ 'bans.hint' | transloco }}</p>
      @if (loaded() && !items().length) {
        <p class="muted" data-no-bans>{{ 'bans.none' | transloco }}</p>
      }
      <ul class="list">
        @for (b of items(); track b.userId) {
          <li [attr.data-ban]="b.displayName">
            <mat-icon>block</mat-icon>
            <span class="who">
              <span>{{ b.displayName }}</span>
              @if (b.reason) {
                <span class="muted small">{{ b.reason }}</span>
              }
            </span>
            <button mat-stroked-button type="button" (click)="unban(b)" data-action="unban">
              {{ 'bans.unban' | transloco }}
            </button>
          </li>
        }
      </ul>
    </div>
  `,
  styles: LIST_STYLES,
})
export class BansTab {
  readonly teamId = input.required<string>();
  private readonly store = inject(MembershipStore);
  private readonly notify = inject(Notify);

  protected readonly items = signal<BanDto[]>([]);
  protected readonly loaded = signal(false);

  constructor() {
    effect(() => {
      const id = this.teamId();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string): Promise<void> {
    try {
      this.items.set(await this.store.bans(id));
      this.loaded.set(true);
    } catch (e) {
      this.notify.error(accessErrorKey(e));
    }
  }

  protected async unban(b: BanDto): Promise<void> {
    try {
      await this.store.unban(this.teamId(), b.userId);
      this.notify.info('bans.lifted', { name: b.displayName });
    } catch (e) {
      this.notify.error(accessErrorKey(e));
    }
    await this.load(this.teamId());
  }
}

// ---------------------------------------------------------------- discoverability

/** Whether the team is listed in the public directory, how people get in from there, and how its card reads. */
@Component({
  selector: 'app-discover-tab',
  imports: [FormsModule, MatButtonModule, TranslocoPipe],
  template: `
    <form class="form" (ngSubmit)="save()" data-discover-tab>
      <label class="check">
        <input type="checkbox" name="isPublic" [(ngModel)]="isPublic" data-field="is-public" />
        <span>
          {{ 'discover.public' | transloco }}
          <span class="muted small">{{ 'discover.publicHint' | transloco }}</span>
        </span>
      </label>

      <fieldset [disabled]="!isPublic">
        <label>
          {{ 'discover.policy' | transloco }}
          <select name="policy" [(ngModel)]="policy" data-field="policy">
            <option value="request">{{ 'discover.policyRequest' | transloco }}</option>
            <option value="open">{{ 'discover.policyOpen' | transloco }}</option>
          </select>
        </label>
        <label>
          {{ 'discover.blurb' | transloco }}
          <input name="blurb" [(ngModel)]="blurb" maxlength="200" data-field="blurb" />
        </label>
        <label>
          {{ 'discover.tags' | transloco }}
          <input
            name="tags"
            [(ngModel)]="tags"
            [placeholder]="'discover.tagsPlaceholder' | transloco"
            data-field="tags"
          />
          <span class="muted small">{{ 'discover.tagsHint' | transloco: { max: maxTags } }}</span>
        </label>
      </fieldset>

      <div>
        <button mat-flat-button type="submit" [disabled]="busy()" data-action="save-discover">
          {{ 'common.save' | transloco }}
        </button>
      </div>
    </form>
  `,
  styles: `
    .form {
      display: flex;
      flex-direction: column;
      gap: 16px;
      max-width: 560px;
    }
    fieldset {
      border: 0;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 13px;
      color: var(--text-dim);
    }
    label.check {
      flex-direction: row;
      gap: 10px;
      align-items: flex-start;
      font-size: 14px;
      color: var(--text);
    }
    .small {
      display: block;
      font-size: 12px;
    }
    input:not([type='checkbox']),
    select {
      font: inherit;
      padding: 7px 9px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface-2);
      color: var(--text);
    }
    fieldset:disabled {
      opacity: 0.5;
    }
  `,
})
export class DiscoverTab {
  readonly teamId = input.required<string>();
  private readonly store = inject(MembershipStore);
  private readonly teams = inject(TeamStore);
  private readonly notify = inject(Notify);

  /** Same as MAX_TAGS in the shared package, which is not loaded on this path (it carries zod); the server enforces it. */
  protected readonly maxTags = 8;
  protected isPublic = false;
  protected policy: JoinPolicy = 'request';
  protected blurb = '';
  protected tags = '';
  protected readonly busy = signal(false);
  private loadedFor = '';

  constructor() {
    effect(() => {
      const team = this.teams.teamById().get(this.teamId());
      // Fill the form once per team: a refresh of the list must not overwrite what the person is typing.
      if (!team || this.loadedFor === team.id) return;
      this.loadedFor = team.id;
      untracked(() => {
        this.isPublic = team.isPublic;
        this.policy = team.joinPolicy;
        this.blurb = team.listingBlurb ?? '';
        this.tags = (team.listingTags ?? []).join(', ');
      });
    });
  }

  protected async save(): Promise<void> {
    this.busy.set(true);
    try {
      await this.store.updateTeam(this.teamId(), {
        isPublic: this.isPublic,
        joinPolicy: this.policy,
        listingBlurb: this.blurb.trim(),
        listingTags: this.tags
          .split(/[,;]+/)
          .map((t) => t.trim())
          .filter(Boolean),
      });
      this.notify.info('discover.saved');
    } catch (e) {
      this.notify.error(toProblem(e).status === 400 ? 'discover.invalid' : accessErrorKey(e));
    } finally {
      this.busy.set(false);
    }
  }
}
