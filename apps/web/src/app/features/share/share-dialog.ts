import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import type { NotebookSharesDto, ShareAccess, ShareDto, ShareLinkDto } from '@os-planner/shared';
import { AuthStore, toProblem } from '../../core/auth-store';
import { Notify } from '../../core/notify';
import { AccessStore } from '../../data/access-store';
import { TeamStore } from '../../data/team-store';
import { TreeStore } from '../../data/tree-store';

export interface ShareDialogData {
  notebookId: string;
  name: string;
}

/** A link made in this dialog: the address is only known now (the server keeps just a hash of the token). */
interface MadeLink extends ShareLinkDto {
  address: string;
}

const EXPIRY_CHOICES = [0, 1, 7, 30, 90] as const;

/**
 * Who has access to a notebook: people (a personal notebook, read or edit, by name or address) and links (read, or edit
 * with a login; optional expiry and password). A team's notebook has no people here (roles and overwrites decide) and only
 * read links, when the team allows them.
 */
@Component({
  selector: 'app-share-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <h2 mat-dialog-title>{{ 'share.title' | transloco: { name: data.name } }}</h2>
    <mat-dialog-content>
      @if (personal()) {
        <nav class="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            [class.on]="tab() === 'people'"
            [attr.aria-selected]="tab() === 'people'"
            (click)="tab.set('people')"
            data-tab="people"
          >
            {{ 'share.people' | transloco }}
          </button>
          <button
            type="button"
            role="tab"
            [class.on]="tab() === 'link'"
            [attr.aria-selected]="tab() === 'link'"
            (click)="tab.set('link')"
            data-tab="link"
          >
            {{ 'share.link' | transloco }}
          </button>
        </nav>
      }

      @if (tab() === 'people' && personal()) {
        <form class="add" (ngSubmit)="add()">
          <input
            name="who"
            [(ngModel)]="who"
            list="share-people"
            [placeholder]="'share.whoPlaceholder' | transloco"
            [attr.aria-label]="'share.whoPlaceholder' | transloco"
            autocomplete="off"
            data-field="share-who"
          />
          <datalist id="share-people">
            @for (c of candidates(); track c.userId) {
              <option [value]="c.name"></option>
            }
          </datalist>
          <select
            name="access"
            [(ngModel)]="newAccess"
            [attr.aria-label]="'share.accessLabel' | transloco"
            data-field="share-access"
          >
            <option value="read">{{ 'share.access.read' | transloco }}</option>
            <option value="edit">{{ 'share.access.edit' | transloco }}</option>
          </select>
          <button
            mat-flat-button
            type="submit"
            [disabled]="busy() || !who.trim()"
            data-action="share-add"
          >
            {{ 'share.add' | transloco }}
          </button>
        </form>
        @if (message(); as m) {
          <p class="msg" role="status" data-share-message>{{ m | transloco }}</p>
        }

        <h3>{{ 'share.whoHasAccess' | transloco }}</h3>
        <ul class="people" data-share-list>
          <li>
            <mat-icon>person</mat-icon><span class="who">{{ 'share.you' | transloco }}</span
            ><span class="role">{{ 'share.owner' | transloco }}</span>
          </li>
          @for (s of shares(); track s.id) {
            <li [attr.data-share]="s.displayName">
              <mat-icon>{{ s.viaLink ? 'link' : 'person' }}</mat-icon>
              <span class="who"
                >{{ s.displayName }}<small>{{ s.email }}</small></span
              >
              <select
                [ngModel]="s.access"
                (ngModelChange)="change(s, $event)"
                [name]="'a' + s.id"
                [attr.aria-label]="'share.accessLabel' | transloco"
              >
                <option value="read">{{ 'share.access.read' | transloco }}</option>
                <option value="edit">{{ 'share.access.edit' | transloco }}</option>
              </select>
              <button
                type="button"
                class="x"
                (click)="remove(s)"
                [attr.aria-label]="'share.remove' | transloco"
                data-action="share-remove"
              >
                <mat-icon>close</mat-icon>
              </button>
            </li>
          }
          @for (p of pending(); track p.id) {
            <li [attr.data-pending]="p.email">
              <mat-icon>schedule_send</mat-icon>
              <span class="who"
                >{{ p.email }}<small>{{ 'share.invited' | transloco }}</small></span
              >
              <span class="role">{{ 'share.access.' + p.access | transloco }}</span>
              <button
                type="button"
                class="x"
                (click)="removePending(p.id)"
                [attr.aria-label]="'share.remove' | transloco"
              >
                <mat-icon>close</mat-icon>
              </button>
            </li>
          }
        </ul>
      } @else {
        @if (teamBlocked()) {
          <p class="msg" data-links-disabled>{{ 'share.teamLinksDisabled' | transloco }}</p>
        } @else {
          <form class="make" (ngSubmit)="makeLink()">
            <label
              >{{ 'share.linkAccess' | transloco }}
              <select name="linkAccess" [(ngModel)]="linkAccess" data-field="link-access">
                <option value="read">{{ 'share.linkRead' | transloco }}</option>
                @if (personal()) {
                  <option value="edit">{{ 'share.linkEdit' | transloco }}</option>
                }
              </select>
            </label>
            <label
              >{{ 'share.expiry' | transloco }}
              <select name="expiry" [(ngModel)]="expiry" data-field="link-expiry">
                @for (d of expiryChoices; track d) {
                  <option [ngValue]="d">
                    {{
                      d === 0 ? ('share.never' | transloco) : ('share.days' | transloco: { n: d })
                    }}
                  </option>
                }
              </select>
            </label>
            <label
              >{{ 'share.password' | transloco }}
              <input
                name="password"
                type="text"
                [(ngModel)]="password"
                autocomplete="off"
                [placeholder]="'share.passwordOptional' | transloco"
                data-field="link-password"
              />
            </label>
            @if (personal()) {
              <label class="check"
                ><input name="authors" type="checkbox" [(ngModel)]="showAuthors" />{{
                  'share.showAuthors' | transloco
                }}</label
              >
            }
            <button mat-flat-button type="submit" [disabled]="busy()" data-action="make-link">
              {{ 'share.createLink' | transloco }}
            </button>
          </form>
          @if (message(); as m) {
            <p class="msg" role="status" data-share-message>{{ m | transloco }}</p>
          }
        }

        <ul class="links" data-link-list>
          @for (l of links(); track l.id) {
            <li [attr.data-link]="l.access">
              <mat-icon>{{ l.hasPassword ? 'lock' : 'link' }}</mat-icon>
              <span class="who">
                @if (l.address) {
                  <input
                    class="addr"
                    readonly
                    [value]="l.address"
                    (focus)="$any($event.target).select()"
                    [attr.aria-label]="'share.link' | transloco"
                    data-link-url
                  />
                } @else {
                  {{ 'share.linkCreated' | transloco }} {{ l.createdAt.slice(0, 10) }}
                }
                <small>
                  {{ 'share.access.' + l.access | transloco }}
                  @if (l.expiresAt) {
                    · {{ 'share.expires' | transloco }} {{ l.expiresAt.slice(0, 10) }}
                  }
                  @if (l.hasPassword) {
                    · {{ 'share.protected' | transloco }}
                  }
                </small>
              </span>
              @if (l.address) {
                <button
                  type="button"
                  class="x"
                  (click)="copy(l.address)"
                  [attr.aria-label]="'share.copy' | transloco"
                  data-action="copy-link"
                >
                  <mat-icon>content_copy</mat-icon>
                </button>
              }
              <button
                type="button"
                class="x"
                (click)="revoke(l)"
                [attr.aria-label]="'share.revoke' | transloco"
                data-action="revoke-link"
              >
                <mat-icon>link_off</mat-icon>
              </button>
            </li>
          } @empty {
            <li class="none">{{ 'share.noLinks' | transloco }}</li>
          }
        </ul>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end"
      ><button mat-button type="button" mat-dialog-close>
        {{ 'common.close' | transloco }}
      </button></mat-dialog-actions
    >
  `,
  styles: `
    :host {
      display: block;
    }
    .tabs {
      display: flex;
      gap: 4px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 12px;
    }
    .tabs button {
      border: 0;
      background: none;
      color: var(--text-dim);
      padding: 8px 14px;
      cursor: pointer;
      font: inherit;
      border-bottom: 2px solid transparent;
    }
    .tabs button.on {
      color: var(--accent);
      border-bottom-color: var(--accent);
      font-weight: 600;
    }
    .add,
    .make {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: end;
    }
    .make label {
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 12px;
      color: var(--text-dim);
    }
    .make label.check {
      flex-direction: row;
      align-items: center;
      gap: 6px;
    }
    input,
    select {
      font: inherit;
      padding: 7px 8px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--text);
      min-width: 0;
    }
    .add input[name='who'] {
      flex: 1 1 180px;
    }
    h3 {
      margin: 16px 0 6px;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
    }
    ul {
      list-style: none;
      margin: 8px 0 0;
      padding: 0;
    }
    li {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 0;
      border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
    }
    li.none {
      color: var(--text-dim);
      border: 0;
    }
    .who {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .who small {
      color: var(--text-dim);
      font-size: 12px;
    }
    .role {
      color: var(--text-dim);
      font-size: 13px;
    }
    .x {
      border: 0;
      background: none;
      color: var(--text-dim);
      cursor: pointer;
      border-radius: 50%;
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
    }
    .x:hover {
      background: var(--surface-3);
    }
    .addr {
      width: 100%;
    }
    .msg {
      margin: 10px 0 0;
      font-size: 13px;
      color: var(--text-dim);
    }
    mat-icon {
      flex: none;
    }
  `,
})
export class ShareDialog {
  readonly data = inject<ShareDialogData>(MAT_DIALOG_DATA);
  private readonly http = inject(HttpClient);
  private readonly tree = inject(TreeStore);
  private readonly teams = inject(TeamStore);
  private readonly access = inject(AccessStore);
  private readonly notify = inject(Notify);
  private readonly auth = inject(AuthStore);

  readonly expiryChoices = EXPIRY_CHOICES;
  readonly tab = signal<'people' | 'link'>('people');
  readonly shares = signal<ShareDto[]>([]);
  readonly pending = signal<NotebookSharesDto['pending']>([]);
  readonly links = signal<MadeLink[]>([]);
  readonly busy = signal(false);
  readonly message = signal<string | null>(null);

  who = '';
  newAccess: ShareAccess = 'read';
  linkAccess: ShareAccess = 'read';
  expiry: number = 0;
  password = '';
  showAuthors = false;

  /** A notebook of the person's own space can be shared with people; a team's cannot (its roles decide). */
  readonly personal = computed(() =>
    this.access.isOwn(this.tree.notebookById().get(this.data.notebookId)),
  );
  /** Public links of a team's notebook only exist while the team allows them. */
  readonly teamBlocked = computed(() => {
    if (this.personal()) return false;
    const space = this.tree.notebookById().get(this.data.notebookId)?.spaceId;
    const place = this.teams.placeOfSpace(space);
    return !place?.team?.allowPublicLinks;
  });

  /** Teammates who could be picked by name: everybody who shares a team with the person, except those who already have access. */
  readonly candidates = computed(() => {
    const have = new Set(this.shares().map((s) => s.userId));
    const seen = new Map<string, { userId: string; name: string }>();
    for (const m of this.teams.members()) {
      if (m.userId === this.auth.userId() || have.has(m.userId)) continue;
      seen.set(m.userId, { userId: m.userId, name: m.nickname || m.displayName });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  });

  constructor() {
    if (!this.personal()) this.tab.set('link');
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const calls: Promise<unknown>[] = [
        firstValueFrom(
          this.http.get<ShareLinkDto[]>(`/api/notebooks/${this.data.notebookId}/links`),
        ).then((l) => this.links.set(l.map((x) => ({ ...x, address: '' })))),
      ];
      if (this.personal())
        calls.push(
          firstValueFrom(
            this.http.get<NotebookSharesDto>(`/api/notebooks/${this.data.notebookId}/shares`),
          ).then((s) => (this.shares.set(s.shares), this.pending.set(s.pending))),
        );
      await Promise.all(calls);
    } catch (e) {
      this.message.set(this.errorKey(e));
    }
  }

  private errorKey(e: unknown): string {
    const p = toProblem(e);
    if (p.offline) return 'share.errors.offline';
    const known = [
      'user_not_found',
      'cannot_share_with_self',
      'share_limit_reached',
      'link_limit_reached',
      'public_links_disabled',
      'team_links_read_only',
      'forbidden',
    ];
    return known.includes(p.code) ? `share.errors.${p.code}` : 'share.errors.generic';
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.message.set(null);
    try {
      await fn();
    } catch (e) {
      this.message.set(this.errorKey(e));
    } finally {
      this.busy.set(false);
    }
  }

  private async reloadShares(): Promise<void> {
    const s = await firstValueFrom(
      this.http.get<NotebookSharesDto>(`/api/notebooks/${this.data.notebookId}/shares`),
    );
    this.shares.set(s.shares);
    this.pending.set(s.pending);
  }

  add(): Promise<void> {
    const typed = this.who.trim();
    return this.run(async () => {
      const match = this.candidates().find((c) => c.name.toLowerCase() === typed.toLowerCase());
      const body = match
        ? { userId: match.userId, access: this.newAccess }
        : typed.includes('@')
          ? { email: typed, access: this.newAccess }
          : null;
      if (!body) {
        this.message.set('share.errors.notFound');
        return;
      }
      await firstValueFrom(this.http.put(`/api/notebooks/${this.data.notebookId}/shares`, body));
      this.who = '';
      await this.reloadShares();
      this.message.set(match ? null : 'share.sentTo');
    });
  }

  change(s: ShareDto, access: ShareAccess): Promise<void> {
    return this.run(async () => {
      await firstValueFrom(
        this.http.put(`/api/notebooks/${this.data.notebookId}/shares`, {
          userId: s.userId,
          access,
        }),
      );
      await this.reloadShares();
    });
  }

  remove(s: ShareDto): Promise<void> {
    return this.run(async () => {
      await firstValueFrom(
        this.http.delete(`/api/notebooks/${this.data.notebookId}/shares/${s.id}`),
      );
      await this.reloadShares();
    });
  }

  removePending(id: string): Promise<void> {
    return this.run(async () => {
      await firstValueFrom(
        this.http.delete(`/api/notebooks/${this.data.notebookId}/pending-shares/${id}`),
      );
      await this.reloadShares();
    });
  }

  makeLink(): Promise<void> {
    return this.run(async () => {
      const made = await firstValueFrom(
        this.http.post<ShareLinkDto>(`/api/notebooks/${this.data.notebookId}/links`, {
          access: this.personal() ? this.linkAccess : 'read',
          ...(this.expiry ? { expiresInDays: this.expiry } : {}),
          ...(this.password.trim() ? { password: this.password.trim() } : {}),
          ...(this.personal() ? { showAuthors: this.showAuthors } : {}),
        }),
      );
      this.password = '';
      // The address is built from where the app is open: that is where the reader page lives.
      this.links.update((l) => [{ ...made, address: `${location.origin}/s/${made.token}` }, ...l]);
    });
  }

  revoke(l: MadeLink): Promise<void> {
    return this.run(async () => {
      await firstValueFrom(this.http.delete(`/api/links/${l.id}`));
      this.links.update((list) => list.filter((x) => x.id !== l.id));
    });
  }

  async copy(address: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
      this.notify.info('share.copied');
    } catch {
      /* the address is selectable in its field */
    }
  }
}
