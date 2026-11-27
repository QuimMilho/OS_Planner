import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { Permission } from '@os-planner/shared/lite';
import type {
  CalendarFeedDto,
  ExternalCalendarDto,
  FeedIncludeDto,
  IcsImportPreviewDto,
  IcsImportResultDto,
} from '@os-planner/shared';
import { toProblem } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { CalendarStore } from '../../data/calendar-store';
import { IcsStore, MAX_ICS_BYTES } from '../../data/ics-store';
import { TeamStore } from '../../data/team-store';
import { Dialogs } from '../../shared/dialogs';
import { AuthStore } from '../../core/auth-store';

const KNOWN_ERRORS = [
  'ics_bad_url',
  'ics_blocked_address',
  'ics_unreachable',
  'ics_timeout',
  'ics_too_large',
  'ics_not_a_calendar',
  'ics_too_many_events',
  'ics_too_many_redirects',
  'ics_http_error',
  'ics_quota',
  'ics_parse_timeout',
  'refresh_too_soon',
  'too_many_feeds',
  'too_many_calendars',
  'no_file',
  'no_events',
  'offline',
  'forbidden',
  'not_found',
  'quota_exceeded',
  'http_413',
];

/** The translation key for what went wrong (the server's code, or the website's own). */
export const icsErrKey = (code: string | null): string =>
  'ics.error.' + (code && KNOWN_ERRORS.includes(code) ? code : 'error');

const EVERY = [15, 30, 60, 180, 360, 720, 1440];
const INCLUDE_KEYS = ['meetings', 'events', 'tasks', 'declined'] as const;
type IncludeKey = (typeof INCLUDE_KEYS)[number];
const COLOURS = [
  '#6b7280',
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
];

interface Secret {
  id: string;
  name: string;
  url: string;
  renewed: boolean;
}

/**
 * Settings → Calendar sync (phase 14): the private address other calendar apps follow, calendars from elsewhere that this one
 * follows, and importing and exporting calendar files. Everything here talks to the server; offline it says so.
 */
@Component({
  selector: 'app-calendar-sync',
  imports: [FormsModule, MatButtonModule, MatIconModule, TranslocoPipe],
  template: `
    <p class="muted">{{ 'calendarSync.intro' | transloco }}</p>

    <!-- ------------------------------------------------ feeds -->
    <section class="part" data-sync-feeds>
      <h3>{{ 'calendarSync.feeds.title' | transloco }}</h3>
      <p class="muted">{{ 'calendarSync.feeds.hint' | transloco }}</p>

      @if (secret(); as s) {
        <div class="secret" role="status" data-feed-secret>
          <strong>{{
            (s.renewed ? 'calendarSync.feeds.renewedTitle' : 'calendarSync.feeds.secretTitle')
              | transloco: { name: s.name }
          }}</strong>
          <p class="warn">{{ 'calendarSync.feeds.secretShown' | transloco }}</p>
          <div class="urlrow">
            <input
              type="text"
              readonly
              [value]="s.url"
              data-feed-url
              [attr.aria-label]="'calendarSync.feeds.secretTitle' | transloco: { name: s.name }"
              (focus)="$any($event.target).select()"
            />
            <button mat-stroked-button type="button" (click)="copy(s.url)" data-feed-copy>
              <mat-icon>content_copy</mat-icon>{{ 'calendarSync.feeds.copy' | transloco }}
            </button>
          </div>
          <div class="qrrow">
            @if (qr()) {
              <img [src]="qr()" width="132" height="132" alt="" data-feed-qr />
              <span class="muted">{{ 'calendarSync.feeds.qr' | transloco }}</span>
            }
          </div>
          <details>
            <summary>{{ 'calendarSync.feeds.how' | transloco }}</summary>
            <ul class="how">
              @for (app of apps; track app) {
                <li>
                  <strong>{{ 'calendarSync.how.' + app + '.name' | transloco }}</strong>:
                  {{ 'calendarSync.how.' + app + '.steps' | transloco }}
                </li>
              }
            </ul>
            <p class="muted">{{ 'calendarSync.feeds.apiNote' | transloco }}</p>
          </details>
          <button mat-button type="button" (click)="secret.set(null)" data-feed-done>
            {{ 'calendarSync.feeds.done' | transloco }}
          </button>
        </div>
      }

      <ul class="list" data-feed-list>
        @for (f of store.feeds(); track f.id) {
          <li class="item" data-feed-row [attr.data-feed-name]="f.name">
            <div class="head">
              <strong>{{ f.name }}</strong>
              <span class="muted">…{{ f.tokenHint }}</span>
              <span class="spacer"></span>
              <button mat-button type="button" (click)="renew(f)" data-feed-rotate>
                {{ 'calendarSync.feeds.renew' | transloco }}
              </button>
              <button
                mat-button
                type="button"
                class="danger"
                (click)="removeFeed(f)"
                data-feed-delete
              >
                {{ 'common.delete' | transloco }}
              </button>
            </div>
            <div class="checks">
              @for (k of includeKeys; track k) {
                <label class="chk"
                  ><input
                    type="checkbox"
                    [checked]="f.include[k]"
                    (change)="setInclude(f, k, $any($event.target).checked)"
                    [attr.data-feed-include]="k"
                  />{{ 'calendarSync.feeds.include.' + k | transloco }}</label
                >
              }
            </div>
            <p class="muted small">
              {{
                f.lastFetchedAt
                  ? ('calendarSync.feeds.lastFetched'
                    | transloco: { when: when(f.lastFetchedAt), n: f.fetchCount })
                  : ('calendarSync.feeds.neverFetched' | transloco)
              }}
            </p>
          </li>
        } @empty {
          <li class="muted" data-feed-empty>{{ 'calendarSync.feeds.empty' | transloco }}</li>
        }
      </ul>

      <form class="form" (ngSubmit)="createFeed()" data-feed-form>
        <label class="field"
          ><span>{{ 'calendarSync.feeds.name' | transloco }}</span>
          <input
            type="text"
            name="feedName"
            [(ngModel)]="feedName"
            maxlength="80"
            [placeholder]="'calendarSync.feeds.namePlaceholder' | transloco"
            data-feed-name-input
          />
        </label>
        <div class="checks">
          @for (k of includeKeys; track k) {
            <label class="chk"
              ><input
                type="checkbox"
                [name]="'inc-' + k"
                [ngModel]="feedInclude()[k]"
                (ngModelChange)="setNew(k, $event)"
              />{{ 'calendarSync.feeds.include.' + k | transloco }}</label
            >
          }
        </div>
        <div class="checks">
          <label class="chk"
            ><input
              type="radio"
              name="feedSpaces"
              value="all"
              [ngModel]="feedScope()"
              (ngModelChange)="feedScope.set($event)"
            />{{ 'calendarSync.feeds.allSpaces' | transloco }}</label
          >
          <label class="chk"
            ><input
              type="radio"
              name="feedSpaces"
              value="some"
              [ngModel]="feedScope()"
              (ngModelChange)="feedScope.set($event)"
            />{{ 'calendarSync.feeds.onlySpaces' | transloco }}</label
          >
        </div>
        @if (feedScope() === 'some') {
          <div class="checks">
            @for (s of spaces(); track s.id) {
              <label class="chk"
                ><input
                  type="checkbox"
                  [name]="'sp-' + s.id"
                  [checked]="pickedSpaces().has(s.id)"
                  (change)="togglePicked(s.id)"
                />{{ s.name }}</label
              >
            }
          </div>
        }
        <div>
          <button
            mat-flat-button
            type="submit"
            [disabled]="
              busy() || !feedName.trim() || (feedScope() === 'some' && !pickedSpaces().size)
            "
            data-feed-create
          >
            {{ 'calendarSync.feeds.create' | transloco }}
          </button>
        </div>
      </form>
    </section>

    <!-- ------------------------------------------------ followed calendars -->
    <section class="part" data-sync-external>
      <h3>{{ 'calendarSync.external.title' | transloco }}</h3>
      <p class="muted">{{ 'calendarSync.external.hint' | transloco }}</p>
      <ul class="list" data-ext-list>
        @for (c of store.calendars(); track c.id) {
          <li class="item" data-ext-row [attr.data-ext-name]="c.name">
            <div class="head">
              <span class="dot" [style.background]="c.color"></span>
              <strong>{{ c.name }}</strong>
              <span class="status" [class.bad]="!!c.lastError || !c.enabled" data-ext-status>
                @if (!c.enabled) {
                  {{
                    (c.disabledReason
                      ? 'calendarSync.external.offByServer'
                      : 'calendarSync.external.paused'
                    ) | transloco
                  }}
                } @else if (c.lastError) {
                  {{ 'calendarSync.external.failing' | transloco }}
                } @else {
                  {{ 'calendarSync.external.ok' | transloco }}
                }
              </span>
              <span class="spacer"></span>
              <button
                mat-button
                type="button"
                (click)="refresh(c)"
                [disabled]="busy()"
                data-ext-refresh
              >
                {{ 'calendarSync.external.refresh' | transloco }}
              </button>
              <button mat-button type="button" (click)="toggle(c)" data-ext-toggle>
                {{
                  (c.enabled ? 'calendarSync.external.pause' : 'calendarSync.external.resume')
                    | transloco
                }}
              </button>
              <button mat-button type="button" class="danger" (click)="unfollow(c)" data-ext-remove>
                {{ 'common.delete' | transloco }}
              </button>
            </div>
            <p class="muted small url">{{ c.url }}</p>
            @if (c.lastError) {
              <p class="err" role="alert" data-ext-error>{{ icsErr(c.lastError) | transloco }}</p>
            }
            <p class="muted small">
              {{
                c.lastSyncAt
                  ? ('calendarSync.external.lastSync' | transloco: { when: when(c.lastSyncAt) })
                  : ('calendarSync.external.never' | transloco)
              }}
              · {{ 'calendarSync.external.events' | transloco: { n: c.eventCount } }}
            </p>
          </li>
        } @empty {
          <li class="muted" data-ext-empty>{{ 'calendarSync.external.empty' | transloco }}</li>
        }
      </ul>
      <form class="form" (ngSubmit)="follow()" data-ext-form>
        <label class="field"
          ><span>{{ 'calendarSync.external.name' | transloco }}</span>
          <input
            type="text"
            name="extName"
            [(ngModel)]="extName"
            maxlength="80"
            data-ext-name-input
          />
        </label>
        <label class="field wide"
          ><span>{{ 'calendarSync.external.url' | transloco }}</span>
          <input
            type="text"
            name="extUrl"
            [(ngModel)]="extUrl"
            maxlength="2000"
            placeholder="https://…  /  webcal://…"
            autocomplete="off"
            spellcheck="false"
            data-ext-url-input
          />
        </label>
        <div class="row">
          <label class="field"
            ><span>{{ 'calendarSync.external.color' | transloco }}</span>
            <span
              class="swatches"
              role="radiogroup"
              [attr.aria-label]="'calendarSync.external.color' | transloco"
            >
              @for (c of colours; track c) {
                <button
                  type="button"
                  class="sw"
                  [class.on]="extColor() === c"
                  [style.background]="c"
                  role="radio"
                  [attr.aria-checked]="extColor() === c"
                  [attr.aria-label]="c"
                  (click)="extColor.set(c)"
                ></button>
              }
            </span>
          </label>
          <label class="field"
            ><span>{{ 'calendarSync.external.every' | transloco }}</span>
            <select name="extEvery" [ngModel]="extEvery()" (ngModelChange)="extEvery.set(+$event)">
              @for (m of everyChoices; track m) {
                <option [value]="m">{{ 'calendarSync.every.' + m | transloco }}</option>
              }
            </select>
          </label>
        </div>
        @if (extError()) {
          <p class="err" role="alert" data-ext-add-error>{{ extError() | transloco }}</p>
        }
        <div>
          <button
            mat-flat-button
            type="submit"
            [disabled]="busy() || !extName.trim() || !extUrl.trim()"
            data-ext-add
          >
            {{ 'calendarSync.external.add' | transloco }}
          </button>
        </div>
      </form>
    </section>

    <!-- ------------------------------------------------ import and export -->
    <section class="part" data-sync-transfer>
      <h3>{{ 'calendarSync.transfer.title' | transloco }}</h3>
      <div
        class="drop"
        [class.over]="over()"
        (dragover)="$event.preventDefault(); over.set(true)"
        (dragleave)="over.set(false)"
        (drop)="onDrop($event)"
        data-import-drop
      >
        <mat-icon>upload_file</mat-icon>
        <span>{{ 'calendarSync.transfer.drop' | transloco }}</span>
        <label class="pick">
          <input
            type="file"
            accept=".ics,text/calendar"
            (change)="onPick($event)"
            data-import-file
          />
          <span class="btn">{{ 'calendarSync.transfer.choose' | transloco }}</span>
        </label>
      </div>
      @if (importError()) {
        <p class="err" role="alert" data-import-error>{{ importError() | transloco }}</p>
      }
      @if (preview(); as p) {
        <div class="preview" data-import-preview>
          <label class="field"
            ><span>{{ 'calendarSync.transfer.into' | transloco }}</span>
            <select
              [ngModel]="target()"
              (ngModelChange)="setTarget($event)"
              name="importTarget"
              data-import-target
            >
              @for (d of destinations(); track d.id) {
                <option [value]="d.id">{{ d.name }}</option>
              }
            </select>
          </label>
          <p>{{ 'calendarSync.transfer.found' | transloco: { n: p.items.length } }}</p>
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    [checked]="allPicked()"
                    (change)="pickAll($any($event.target).checked)"
                    [attr.aria-label]="'calendarSync.transfer.selectAll' | transloco"
                    data-import-all
                  />
                </th>
                <th>{{ 'calendarSync.transfer.colTitle' | transloco }}</th>
                <th>{{ 'calendarSync.transfer.colWhen' | transloco }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (i of p.items; track i.uid) {
                <tr data-import-row [attr.data-import-title]="i.title" [class.dup]="i.duplicate">
                  <td>
                    <input
                      type="checkbox"
                      [checked]="picked().has(i.uid)"
                      [disabled]="i.duplicate"
                      (change)="togglePick(i.uid)"
                      [attr.aria-label]="i.title"
                      data-import-pick
                    />
                  </td>
                  <td>{{ i.title }}</td>
                  <td>{{ whenRange(i.startAt, i.allDay) }}</td>
                  <td class="tags">
                    @if (i.recurring) {
                      <span class="tag"
                        ><mat-icon>repeat</mat-icon
                        >{{ 'calendarSync.transfer.repeats' | transloco }}</span
                      >
                    }
                    @if (i.duplicate) {
                      <span class="tag" data-import-duplicate>{{
                        'calendarSync.transfer.duplicate' | transloco
                      }}</span>
                    }
                    @if (i.simplified) {
                      <span
                        class="tag"
                        [attr.title]="'calendarSync.transfer.simplifiedHint' | transloco"
                        >{{ 'calendarSync.transfer.simplified' | transloco }}</span
                      >
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
          @if (p.truncated) {
            <p class="muted">{{ 'calendarSync.transfer.truncated' | transloco }}</p>
          }
          @if (p.unsupported.length) {
            <p class="muted">
              {{ 'calendarSync.transfer.unsupported' | transloco: { what: unsupportedText(p) } }}
            </p>
          }
          @if (p.skipped) {
            <p class="muted">{{ 'calendarSync.transfer.skipped' | transloco: { n: p.skipped } }}</p>
          }
          <div class="actions">
            <button
              mat-flat-button
              type="button"
              (click)="commit()"
              [disabled]="busy() || !picked().size"
              data-import-commit
            >
              {{ 'calendarSync.transfer.import' | transloco: { n: picked().size } }}
            </button>
            <button mat-button type="button" (click)="clearImport()" data-import-cancel>
              {{ 'common.cancel' | transloco }}
            </button>
          </div>
        </div>
      }
      @if (result(); as r) {
        <p class="ok" role="status" data-import-result>
          {{
            'calendarSync.transfer.done'
              | transloco: { created: r.created, duplicates: r.duplicates }
          }}
        </p>
      }

      <h4>{{ 'calendarSync.transfer.exportTitle' | transloco }}</h4>
      <div class="row">
        <label class="field"
          ><span>{{ 'calendarSync.transfer.from' | transloco }}</span>
          <input type="date" name="expFrom" [(ngModel)]="expFrom" data-export-from />
        </label>
        <label class="field"
          ><span>{{ 'calendarSync.transfer.to' | transloco }}</span>
          <input type="date" name="expTo" [(ngModel)]="expTo" data-export-to />
        </label>
        <button
          mat-stroked-button
          type="button"
          (click)="download()"
          [disabled]="busy() || !expFrom || !expTo"
          data-export-download
        >
          <mat-icon>download</mat-icon>{{ 'calendarSync.transfer.download' | transloco }}
        </button>
      </div>
    </section>
  `,
  styles: `
    .part {
      margin-top: 18px;
    }
    h3 {
      margin: 0 0 4px;
      font-size: 16px;
    }
    h4 {
      margin: 18px 0 6px;
      font-size: 14px;
    }
    .muted {
      color: var(--text-dim);
    }
    .small {
      font-size: 12px;
      margin: 2px 0;
    }
    .list {
      list-style: none;
      padding: 0;
      margin: 10px 0;
      display: grid;
      gap: 8px;
    }
    .item {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 8px 12px;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .spacer {
      flex: 1;
    }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      flex: none;
    }
    .status {
      font-size: 12px;
      padding: 1px 8px;
      border-radius: 8px;
      background: var(--surface-3);
    }
    .status.bad {
      background: color-mix(in srgb, #d97706 25%, var(--surface));
    }
    .url {
      overflow-wrap: anywhere;
    }
    .checks {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 16px;
      margin: 6px 0;
    }
    .chk {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 14px;
    }
    .form {
      display: grid;
      gap: 10px;
      margin-top: 12px;
      max-width: 640px;
    }
    .field {
      display: grid;
      gap: 3px;
      font-size: 13px;
    }
    .field.wide {
      grid-column: 1 / -1;
    }
    input[type='text'],
    input[type='date'],
    select {
      font: inherit;
      color: var(--text);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 7px 9px;
    }
    .row {
      display: flex;
      gap: 14px;
      flex-wrap: wrap;
      align-items: flex-end;
    }
    .swatches {
      display: flex;
      gap: 6px;
      padding: 4px 0;
    }
    .sw {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 2px solid transparent;
      cursor: pointer;
    }
    .sw.on {
      border-color: var(--text);
    }
    .secret {
      border: 1px solid var(--mat-sys-primary);
      border-radius: 10px;
      padding: 10px 14px;
      margin: 10px 0;
      display: grid;
      gap: 8px;
    }
    .warn {
      margin: 0;
      color: #b45309;
    }
    .urlrow {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .urlrow input {
      flex: 1;
      min-width: 0;
      font-family: ui-monospace, monospace;
      font-size: 12px;
    }
    .qrrow {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .how {
      padding-left: 18px;
    }
    .err {
      color: #b91c1c;
      margin: 4px 0;
    }
    .ok {
      color: #15803d;
    }
    .danger {
      color: #b91c1c;
    }
    .drop {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      border: 2px dashed var(--border);
      border-radius: 12px;
      padding: 14px;
      margin: 10px 0;
    }
    .drop.over {
      border-color: var(--mat-sys-primary);
      background: color-mix(in srgb, var(--mat-sys-primary) 8%, transparent);
    }
    .pick input {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
    }
    .pick .btn {
      display: inline-block;
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 6px 14px;
      cursor: pointer;
    }
    .pick input:focus-visible + .btn {
      outline: 2px solid var(--mat-sys-primary);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 14px;
    }
    th,
    td {
      text-align: left;
      padding: 4px 8px;
      border-bottom: 1px solid var(--border);
    }
    tr.dup td {
      opacity: 0.6;
    }
    .tags {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .tag {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      font-size: 11px;
      padding: 1px 8px;
      border-radius: 8px;
      background: var(--surface-3);
    }
    .tag mat-icon {
      font-size: 13px;
      width: 13px;
      height: 13px;
    }
    .actions {
      display: flex;
      gap: 8px;
    }
  `,
})
export class CalendarSync implements OnInit {
  protected readonly store = inject(IcsStore);
  private readonly cal = inject(CalendarStore);
  private readonly teams = inject(TeamStore);
  private readonly auth = inject(AuthStore);
  private readonly lang = inject(Language);
  private readonly notify = inject(Notify);
  private readonly dialogs = inject(Dialogs);

  protected readonly includeKeys = INCLUDE_KEYS;
  protected readonly apps = ['google', 'outlook', 'apple'] as const;
  protected readonly colours = COLOURS;
  protected readonly everyChoices = EVERY;
  protected readonly busy = signal(false);

  // feeds
  protected feedName = '';
  protected readonly feedInclude = signal<Record<IncludeKey, boolean>>({
    meetings: true,
    events: true,
    tasks: true,
    declined: false,
  });
  protected readonly feedScope = signal<'all' | 'some'>('all');
  protected readonly pickedSpaces = signal(new Set<string>());
  protected readonly secret = signal<Secret | null>(null);
  protected readonly qr = signal('');

  // followed calendars
  protected extName = '';
  protected extUrl = '';
  protected readonly extColor = signal(COLOURS[1]!);
  protected readonly extEvery = signal(60);
  protected readonly extError = signal('');

  // import and export
  protected readonly over = signal(false);
  protected readonly importError = signal('');
  protected readonly preview = signal<IcsImportPreviewDto | null>(null);
  protected readonly result = signal<IcsImportResultDto | null>(null);
  protected readonly picked = signal(new Set<string>());
  protected readonly target = signal('');
  private file: File | null = null;
  protected expFrom = isoDate(new Date());
  protected expTo = isoDate(new Date(Date.now() + 365 * 86_400_000));

  /** The spaces whose calendar the person can see (what a feed may take from and where an import may go). */
  protected readonly spaces = computed(() => {
    const out: { id: string; name: string }[] = [];
    const personal = this.cal.personalSpaceId();
    if (personal) out.push({ id: personal, name: this.lang.t('calendar.personal') });
    for (const t of this.teams.teams() ?? [])
      if (this.cal.spaceIds().includes(t.spaceId)) out.push({ id: t.spaceId, name: t.name });
    for (const p of this.teams.projects())
      if (this.cal.spaceIds().includes(p.spaceId))
        out.push({
          id: p.spaceId,
          name: `${this.teams.teamById().get(p.teamId)?.name ?? ''} / ${p.name}`,
        });
    return out;
  });

  /** Where an import may go: the person's own calendar, and every space where they may create meetings. */
  protected readonly destinations = computed(() =>
    this.spaces().filter(
      (s) => s.id === this.cal.personalSpaceId() || this.cal.can(s.id, Permission.CREATE_MEETINGS),
    ),
  );

  protected readonly allPicked = computed(() => {
    const items = this.preview()?.items.filter((i) => !i.duplicate) ?? [];
    return items.length > 0 && items.every((i) => this.picked().has(i.uid));
  });

  ngOnInit(): void {
    void this.store.loadFeeds().catch(() => undefined);
    void this.store.loadCalendars().catch(() => undefined);
    this.target.set(this.cal.personalSpaceId() || this.auth.user()?.personalSpaceId || '');
  }

  protected icsErr(code: string | null): string {
    return icsErrKey(code);
  }

  protected when(iso: string): string {
    return new Date(iso).toLocaleString(this.lang.current === 'pt' ? 'pt-PT' : 'en-GB', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  }

  protected whenRange(iso: string, allDay: boolean): string {
    const d = new Date(iso);
    return d.toLocaleString(
      this.lang.current === 'pt' ? 'pt-PT' : 'en-GB',
      allDay
        ? { dateStyle: 'medium', timeZone: 'UTC' }
        : { dateStyle: 'medium', timeStyle: 'short' },
    );
  }

  private fail(e: unknown): string {
    return icsErrKey(toProblem(e).code);
  }

  // ---------------------------------------------------------------- feeds

  protected setNew(k: IncludeKey, on: boolean): void {
    this.feedInclude.update((v) => ({ ...v, [k]: on }));
  }

  protected togglePicked(id: string): void {
    this.pickedSpaces.update((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  }

  protected async createFeed(): Promise<void> {
    if (this.busy() || !this.feedName.trim()) return;
    this.busy.set(true);
    try {
      const include: Partial<FeedIncludeDto> = {
        ...this.feedInclude(),
        spaces: this.feedScope() === 'some' ? [...this.pickedSpaces()] : null,
      };
      const made = await this.store.createFeed(this.feedName.trim(), include);
      this.feedName = '';
      await this.show({ id: made.id, name: made.name, url: made.url, renewed: false });
    } catch (e) {
      this.notify.error(this.fail(e));
    } finally {
      this.busy.set(false);
    }
  }

  private async show(s: Secret): Promise<void> {
    this.qr.set('');
    this.secret.set(s);
    try {
      const mod = await import('qrcode-generator');
      const qr = mod.default(0, 'M');
      qr.addData(s.url);
      qr.make();
      this.qr.set(qr.createDataURL(4, 2));
    } catch {
      /* the address still works without the picture */
    }
  }

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.notify.info('calendarSync.feeds.copied');
    } catch {
      /* clipboard refused: the address is selected in the box */
    }
  }

  protected async renew(f: CalendarFeedDto): Promise<void> {
    if (
      !(await this.dialogs.confirm({
        titleKey: 'calendarSync.feeds.renewTitle',
        messageKey: 'calendarSync.feeds.renewMessage',
        params: { name: f.name },
        confirmKey: 'calendarSync.feeds.renew',
        danger: true,
      }))
    )
      return;
    try {
      const made = await this.store.rotateFeed(f.id);
      await this.show({ id: made.id, name: made.name, url: made.url, renewed: true });
    } catch (e) {
      this.notify.error(this.fail(e));
    }
  }

  protected async removeFeed(f: CalendarFeedDto): Promise<void> {
    if (
      !(await this.dialogs.confirm({
        titleKey: 'calendarSync.feeds.deleteTitle',
        messageKey: 'calendarSync.feeds.deleteMessage',
        params: { name: f.name },
        confirmKey: 'common.delete',
        danger: true,
      }))
    )
      return;
    try {
      await this.store.removeFeed(f.id);
      if (this.secret()?.id === f.id) this.secret.set(null);
    } catch (e) {
      this.notify.error(this.fail(e));
    }
  }

  protected async setInclude(f: CalendarFeedDto, k: IncludeKey, on: boolean): Promise<void> {
    try {
      await this.store.updateFeed(f.id, { include: { [k]: on } });
    } catch (e) {
      this.notify.error(this.fail(e));
      await this.store.loadFeeds().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- followed calendars

  protected async follow(): Promise<void> {
    if (this.busy() || !this.extName.trim() || !this.extUrl.trim()) return;
    this.busy.set(true);
    this.extError.set('');
    try {
      await this.store.follow({
        name: this.extName.trim(),
        url: this.extUrl.trim(),
        color: this.extColor(),
        syncEveryMinutes: this.extEvery(),
      });
      this.extName = this.extUrl = '';
      this.notify.info('calendarSync.external.added');
    } catch (e) {
      this.extError.set(this.fail(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async refresh(c: ExternalCalendarDto): Promise<void> {
    this.busy.set(true);
    try {
      await this.store.refresh(c.id);
      this.notify.info('calendarSync.external.refreshed');
    } catch (e) {
      this.notify.error(this.fail(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected async toggle(c: ExternalCalendarDto): Promise<void> {
    try {
      await this.store.updateCalendar(c.id, { enabled: !c.enabled });
    } catch (e) {
      this.notify.error(this.fail(e));
    }
  }

  protected async unfollow(c: ExternalCalendarDto): Promise<void> {
    if (
      !(await this.dialogs.confirm({
        titleKey: 'calendarSync.external.removeTitle',
        messageKey: 'calendarSync.external.removeMessage',
        params: { name: c.name },
        confirmKey: 'common.delete',
        danger: true,
      }))
    )
      return;
    try {
      await this.store.unfollow(c.id);
    } catch (e) {
      this.notify.error(this.fail(e));
    }
  }

  // ---------------------------------------------------------------- import and export

  protected onDrop(ev: DragEvent): void {
    ev.preventDefault();
    this.over.set(false);
    const f = ev.dataTransfer?.files?.[0];
    if (f) void this.read(f);
  }

  protected onPick(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (f) void this.read(f);
  }

  protected setTarget(id: string): void {
    this.target.set(id);
    if (this.file) void this.read(this.file);
  }

  private async read(file: File): Promise<void> {
    this.importError.set('');
    this.result.set(null);
    if (file.size > MAX_ICS_BYTES) {
      this.importError.set('ics.error.ics_too_large');
      return;
    }
    this.file = file;
    this.busy.set(true);
    try {
      const space = this.target() || null;
      const p = (await this.store.importFile(file, 'preview', space)) as IcsImportPreviewDto;
      this.preview.set(p);
      this.target.set(p.spaceId);
      this.picked.set(new Set(p.items.filter((i) => !i.duplicate).map((i) => i.uid)));
    } catch (e) {
      this.preview.set(null);
      this.importError.set(this.fail(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected togglePick(uid: string): void {
    this.picked.update((s) => {
      const n = new Set(s);
      if (!n.delete(uid)) n.add(uid);
      return n;
    });
  }

  protected pickAll(on: boolean): void {
    this.picked.set(
      on
        ? new Set((this.preview()?.items ?? []).filter((i) => !i.duplicate).map((i) => i.uid))
        : new Set(),
    );
  }

  protected unsupportedText(p: IcsImportPreviewDto): string {
    return p.unsupported.map((u) => `${u.component} ×${u.count}`).join(', ');
  }

  protected async commit(): Promise<void> {
    if (!this.file || !this.picked().size) return;
    this.busy.set(true);
    try {
      const r = (await this.store.importFile(this.file, 'commit', this.target() || null, [
        ...this.picked(),
      ])) as IcsImportResultDto;
      this.result.set(r);
      this.clearImport(false);
    } catch (e) {
      this.importError.set(this.fail(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected clearImport(clearResult = true): void {
    this.preview.set(null);
    this.picked.set(new Set());
    this.file = null;
    this.importError.set('');
    if (clearResult) this.result.set(null);
  }

  protected async download(): Promise<void> {
    this.busy.set(true);
    try {
      const from = new Date(`${this.expFrom}T00:00:00`).toISOString();
      const to = new Date(`${this.expTo}T23:59:59`).toISOString();
      const blob = await this.store.exportRange(from, to);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'calendar.ics';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      this.notify.error(this.fail(e));
    } finally {
      this.busy.set(false);
    }
  }
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
