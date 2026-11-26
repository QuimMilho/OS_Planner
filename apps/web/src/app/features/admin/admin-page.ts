import { HttpClient } from '@angular/common/http';
import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { TranslocoPipe } from '@jsverse/transloco';
import { Subject, debounceTime, firstValueFrom } from 'rxjs';
import type {
  AdminQuotaDto,
  AdminStatsDto,
  AdminTeamDto,
  AdminUserDto,
  AdminUsersPage,
} from '@os-planner/shared';
import { toProblem } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { Dialogs } from '../../shared/dialogs';

const MB = 1024 * 1024;
const toMb = (bytes: number): string => String(Math.round((bytes / MB) * 100) / 100);

interface Editing {
  user: AdminUserDto;
  /** Empty means "use the default". */
  storageMb: string;
  fileMb: string;
  note: string;
  defaultMb: string;
  saving: boolean;
}

/** Instance administration: who is here, how much they store, and per-account limit overrides. */
@Component({
  selector: 'app-admin-page',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    TranslocoPipe,
  ],
  template: `
    <div class="wrap">
      <h1>{{ 'admin.title' | transloco }}</h1>

      @if (stats(); as s) {
        <section class="stats" [attr.aria-label]="'admin.stats' | transloco">
          <div class="stat">
            <strong data-stat="users">{{ s.users }}</strong
            ><span class="muted">{{ 'admin.statUsers' | transloco }}</span>
          </div>
          <div class="stat">
            <strong data-stat="verified">{{ s.verifiedUsers }}</strong
            ><span class="muted">{{ 'admin.statVerified' | transloco }}</span>
          </div>
          <div class="stat">
            <strong data-stat="storage">{{ mb(s.storageBytes) }} MB</strong
            ><span class="muted">{{ 'admin.statStorage' | transloco }}</span>
          </div>
          <div class="stat">
            <strong data-stat="teams">{{ s.teams }}</strong
            ><span class="muted">{{ 'admin.statTeams' | transloco }}</span>
          </div>
        </section>
      }

      <section class="card">
        <h2>{{ 'admin.users' | transloco }}</h2>
        <mat-form-field appearance="outline" class="search">
          <mat-label>{{ 'admin.searchUsers' | transloco }}</mat-label>
          <input
            matInput
            name="q"
            [ngModel]="query()"
            (ngModelChange)="onQuery($event)"
            autocomplete="off"
          />
        </mat-form-field>

        <table class="users">
          <thead>
            <tr>
              <th>{{ 'admin.user' | transloco }}</th>
              <th>{{ 'admin.usage' | transloco }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (u of users(); track u.id) {
              <tr [attr.data-user]="u.email">
                <td>
                  <strong>{{ u.displayName }}</strong>
                  @if (!u.emailVerified) {
                    <mat-icon class="warn" [attr.title]="'settings.unverified' | transloco"
                      >warning</mat-icon
                    >
                  }
                  <div class="muted small">{{ u.email }} · {{ lang.date(u.createdAt) }}</div>
                </td>
                <td class="usage">
                  <div class="bar"><div class="fill" [style.width.%]="pct(u)"></div></div>
                  <span class="small"
                    ><span data-used>{{ mb(u.used) }}</span> /
                    <span data-limit>{{ mb(u.limit) }}</span> MB</span
                  >
                  @if (u.hasOverride) {
                    <span class="tag">{{ 'admin.override' | transloco }}</span>
                  }
                </td>
                <td class="act">
                  <button mat-stroked-button type="button" data-edit (click)="edit(u)">
                    {{ 'admin.edit' | transloco }}
                  </button>
                </td>
              </tr>
              @if (editing(); as e) {
                @if (e.user.id === u.id) {
                  <tr class="editor">
                    <td colspan="3">
                      <form (ngSubmit)="save()" class="form">
                        <mat-form-field appearance="outline">
                          <mat-label>{{ 'admin.storageMb' | transloco }}</mat-label>
                          <input
                            matInput
                            name="storage"
                            type="number"
                            min="0"
                            step="any"
                            [(ngModel)]="e.storageMb"
                            [placeholder]="e.defaultMb"
                          />
                          <mat-hint>{{
                            'admin.defaultHint' | transloco: { value: e.defaultMb }
                          }}</mat-hint>
                        </mat-form-field>
                        <mat-form-field appearance="outline">
                          <mat-label>{{ 'admin.fileMb' | transloco }}</mat-label>
                          <input
                            matInput
                            name="file"
                            type="number"
                            min="0"
                            step="any"
                            [(ngModel)]="e.fileMb"
                          />
                        </mat-form-field>
                        <mat-form-field appearance="outline" class="note">
                          <mat-label>{{ 'admin.note' | transloco }}</mat-label>
                          <input matInput name="note" maxlength="500" [(ngModel)]="e.note" />
                        </mat-form-field>
                        <div class="buttons">
                          <button mat-flat-button type="submit" data-save [disabled]="e.saving">
                            {{ 'common.save' | transloco }}
                          </button>
                          @if (u.hasOverride) {
                            <button
                              mat-stroked-button
                              type="button"
                              data-clear
                              [disabled]="e.saving"
                              (click)="clear()"
                            >
                              {{ 'admin.clear' | transloco }}
                            </button>
                          }
                          <button mat-button type="button" (click)="editing.set(null)">
                            {{ 'common.cancel' | transloco }}
                          </button>
                        </div>
                      </form>
                    </td>
                  </tr>
                }
              }
            } @empty {
              <tr>
                <td colspan="3" class="muted">{{ 'admin.noUsers' | transloco }}</td>
              </tr>
            }
          </tbody>
        </table>
        @if (next()) {
          <button mat-button type="button" (click)="more()">
            {{ 'admin.loadMore' | transloco }}
          </button>
        }
      </section>

      <section class="card" data-admin-teams>
        <h2>{{ 'admin.teams.title' | transloco }}</h2>
        <form class="form" (ngSubmit)="createTeam()">
          <mat-form-field appearance="outline">
            <mat-label>{{ 'admin.teams.name' | transloco }}</mat-label>
            <input
              matInput
              name="teamName"
              maxlength="80"
              required
              [(ngModel)]="newTeam.name"
              autocomplete="off"
            />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>{{ 'admin.teams.owner' | transloco }}</mat-label>
            <input
              matInput
              name="teamOwner"
              type="email"
              required
              [(ngModel)]="newTeam.ownerEmail"
              autocomplete="off"
            />
            <mat-hint>{{ 'admin.teams.ownerHint' | transloco }}</mat-hint>
          </mat-form-field>
          <label class="check"
            ><input type="checkbox" name="teamPublic" [(ngModel)]="newTeam.isPublic" />{{
              'admin.teams.public' | transloco
            }}</label
          >
          <label class="check"
            ><input
              type="checkbox"
              name="teamOpen"
              [(ngModel)]="newTeam.open"
              [disabled]="!newTeam.isPublic"
            />{{ 'admin.teams.openJoin' | transloco }}</label
          >
          <div class="buttons">
            <button mat-flat-button type="submit" data-create-team [disabled]="creatingTeam()">
              {{ 'admin.teams.create' | transloco }}
            </button>
          </div>
        </form>

        <table class="users">
          <thead>
            <tr>
              <th>{{ 'admin.teams.name' | transloco }}</th>
              <th>{{ 'admin.teams.owner' | transloco }}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (t of teams(); track t.id) {
              <tr [attr.data-team-row]="t.name">
                <td>
                  <strong>{{ t.name }}</strong>
                  <div class="muted small">
                    {{ t.memberCount }} {{ 'admin.teams.members' | transloco }} ·
                    {{ t.projectCount }} {{ 'admin.teams.projects' | transloco }} ·
                    {{ mb(t.used) }} MB
                  </div>
                </td>
                <td>
                  @if (t.owner) {
                    {{ t.owner.displayName }}
                    <div class="muted small">{{ t.owner.email }}</div>
                  } @else if (t.pendingOwnerEmail) {
                    <span class="tag" data-pending>{{ 'admin.teams.pending' | transloco }}</span>
                    <div class="muted small">{{ t.pendingOwnerEmail }}</div>
                  }
                </td>
                <td class="act">
                  <button mat-stroked-button type="button" data-delete-team (click)="deleteTeam(t)">
                    {{ 'common.delete' | transloco }}
                  </button>
                </td>
              </tr>
            } @empty {
              <tr>
                <td colspan="3" class="muted">{{ 'admin.teams.none' | transloco }}</td>
              </tr>
            }
          </tbody>
        </table>
      </section>
    </div>
  `,
  styles: `
    .wrap {
      max-width: 920px;
      margin: 0 auto;
      padding: 24px 20px 64px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    h1 {
      margin: 0;
    }
    .card {
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px 24px;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 18px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
      gap: 12px;
    }
    .stat {
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .stat strong {
      font-size: 24px;
    }
    .search {
      width: 100%;
      max-width: 360px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      text-align: left;
      font-size: 13px;
      color: var(--text-dim);
      font-weight: 500;
      padding: 4px 8px;
    }
    td {
      padding: 10px 8px;
      border-top: 1px solid var(--border);
      vertical-align: middle;
    }
    .small {
      font-size: 13px;
    }
    .act {
      text-align: right;
      white-space: nowrap;
    }
    .usage {
      min-width: 190px;
    }
    .bar {
      height: 8px;
      border-radius: 4px;
      background: var(--surface-3);
      overflow: hidden;
      margin-bottom: 4px;
    }
    .fill {
      height: 100%;
      background: var(--accent);
    }
    .tag {
      margin-left: 6px;
      font-size: 12px;
      padding: 1px 8px;
      border-radius: 999px;
      background: var(--surface-3);
    }
    mat-icon.warn {
      color: #e8590c;
      font-size: 18px;
      width: 18px;
      height: 18px;
      vertical-align: middle;
      margin-left: 4px;
    }
    .form {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      align-items: flex-start;
      padding-top: 8px;
    }
    .form mat-form-field {
      width: 200px;
    }
    .form .note {
      flex: 1;
      min-width: 220px;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 56px;
      font-size: 14px;
    }
    .buttons {
      display: flex;
      gap: 8px;
      align-items: center;
      height: 56px;
    }
    @media (max-width: 640px) {
      .card {
        padding: 16px;
      }
      .usage {
        min-width: 130px;
      }
    }
  `,
})
export class AdminPage implements OnInit {
  readonly lang = inject(Language);
  private readonly http = inject(HttpClient);
  private readonly notify = inject(Notify);

  readonly stats = signal<AdminStatsDto | null>(null);
  readonly users = signal<AdminUserDto[]>([]);
  readonly next = signal<string | null>(null);
  readonly query = signal('');
  readonly editing = signal<Editing | null>(null);
  private readonly search$ = new Subject<string>();
  private readonly dialogs = inject(Dialogs);

  readonly teams = signal<AdminTeamDto[]>([]);
  readonly creatingTeam = signal(false);
  newTeam = { name: '', ownerEmail: '', isPublic: false, open: false };

  constructor() {
    this.search$.pipe(debounceTime(300)).subscribe((q) => void this.load(q));
  }

  ngOnInit(): void {
    void this.load('');
    void this.loadTeams();
    void firstValueFrom(this.http.get<AdminStatsDto>('/api/admin/stats')).then(
      (s) => this.stats.set(s),
      () => undefined,
    );
  }

  mb(bytes: number): string {
    return toMb(bytes);
  }

  pct(u: AdminUserDto): number {
    return u.limit ? Math.min(100, (u.used / u.limit) * 100) : 0;
  }

  onQuery(q: string): void {
    this.query.set(q);
    this.search$.next(q.trim());
  }

  private async load(q: string): Promise<void> {
    try {
      const page = await firstValueFrom(
        this.http.get<AdminUsersPage>('/api/admin/users', { params: q ? { q } : {} }),
      );
      this.users.set(page.items);
      this.next.set(page.nextCursor);
    } catch (e) {
      this.fail(e);
    }
  }

  async more(): Promise<void> {
    const cursor = this.next();
    if (!cursor) return;
    try {
      const q = this.query().trim();
      const page = await firstValueFrom(
        this.http.get<AdminUsersPage>('/api/admin/users', {
          params: { cursor, ...(q ? { q } : {}) },
        }),
      );
      this.users.update((list) => [...list, ...page.items]);
      this.next.set(page.nextCursor);
    } catch (e) {
      this.fail(e);
    }
  }

  async edit(u: AdminUserDto): Promise<void> {
    if (this.editing()?.user.id === u.id) return void this.editing.set(null);
    try {
      const q = await firstValueFrom(
        this.http.get<AdminQuotaDto>(`/api/admin/quotas/user/${u.id}`),
      );
      this.editing.set({
        user: u,
        storageMb: q.override?.storageBytes != null ? toMb(q.override.storageBytes) : '',
        fileMb: q.override?.maxFileBytes != null ? toMb(q.override.maxFileBytes) : '',
        note: q.override?.note ?? '',
        defaultMb: toMb(q.defaults.storageBytes),
        saving: false,
      });
    } catch (e) {
      this.fail(e);
    }
  }

  async save(): Promise<void> {
    const e = this.editing();
    if (!e) return;
    const bytes = (mb: string): number | null =>
      mb === '' || mb == null ? null : Math.round(Number(mb) * MB);
    const storageBytes = bytes(e.storageMb);
    const maxFileBytes = bytes(e.fileMb);
    if ([storageBytes, maxFileBytes].some((v) => v !== null && (!Number.isFinite(v) || v < 0)))
      return void this.notify.error('admin.invalid');
    e.saving = true;
    try {
      const res = await firstValueFrom(
        this.http.put<AdminQuotaDto>(`/api/admin/quotas/user/${e.user.id}`, {
          storageBytes,
          maxFileBytes,
          note: e.note,
        }),
      );
      this.applyRow(e.user.id, res);
      this.editing.set(null);
      this.notify.info('admin.saved');
    } catch (err) {
      e.saving = false;
      this.fail(err);
    }
  }

  async clear(): Promise<void> {
    const e = this.editing();
    if (!e) return;
    e.saving = true;
    try {
      const res = await firstValueFrom(
        this.http.delete<AdminQuotaDto>(`/api/admin/quotas/user/${e.user.id}`),
      );
      this.applyRow(e.user.id, res);
      this.editing.set(null);
      this.notify.info('admin.cleared');
    } catch (err) {
      e.saving = false;
      this.fail(err);
    }
  }

  private async loadTeams(): Promise<void> {
    try {
      this.teams.set(await firstValueFrom(this.http.get<AdminTeamDto[]>('/api/admin/teams')));
    } catch (e) {
      this.fail(e);
    }
  }

  async createTeam(): Promise<void> {
    const t = this.newTeam;
    const name = t.name.trim();
    const ownerEmail = t.ownerEmail.trim();
    if (!name || !ownerEmail) return;
    this.creatingTeam.set(true);
    try {
      await firstValueFrom(
        this.http.post<AdminTeamDto>('/api/admin/teams', {
          name,
          ownerEmail,
          isPublic: t.isPublic,
          joinPolicy: t.isPublic && t.open ? 'open' : 'request',
        }),
      );
      this.newTeam = { name: '', ownerEmail: '', isPublic: false, open: false };
      await this.loadTeams();
      this.notify.info('admin.teams.created');
    } catch (e) {
      const p = toProblem(e);
      this.notify.error(
        p.offline ? 'errors.offline' : p.status === 422 ? 'admin.invalid' : 'errors.generic',
      );
    } finally {
      this.creatingTeam.set(false);
    }
  }

  async deleteTeam(t: AdminTeamDto): Promise<void> {
    const sure = await this.dialogs.confirm({
      titleKey: 'admin.teams.deleteTitle',
      messageKey: 'admin.teams.deleteMessage',
      params: { name: t.name },
      confirmKey: 'common.delete',
      danger: true,
    });
    if (!sure) return;
    try {
      await firstValueFrom(this.http.delete(`/api/admin/teams/${t.id}`));
      await this.loadTeams();
    } catch (e) {
      this.fail(e);
    }
  }

  private applyRow(id: string, q: AdminQuotaDto): void {
    this.users.update((list) =>
      list.map((u) =>
        u.id === id
          ? {
              ...u,
              limit: q.effective.storageBytes,
              used: q.used,
              hasOverride: q.override !== null,
            }
          : u,
      ),
    );
  }

  private fail(e: unknown): void {
    const code = toProblem(e).code;
    this.notify.error(code === 'offline' ? 'errors.offline' : 'errors.generic');
  }
}
