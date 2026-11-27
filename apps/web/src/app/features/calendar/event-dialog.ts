import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { Permission } from '@os-planner/shared/lite';
import type {
  AttendeeInput,
  CalendarPeopleDto,
  EditScope,
  EventDetailDto,
  EventDto,
  RsvpAnswer,
} from '@os-planner/shared';
import {
  describeRRule,
  formatRRule,
  isValidTimeZone,
  normalizeTiming,
  parseRRule,
  presetOf,
  ruleOfPreset,
  type RepeatPreset,
  type RRule,
} from '@os-planner/shared/calendar';
import { toProblem } from '../../core/auth-store';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { CalendarError, CalendarStore } from '../../data/calendar-store';
import { TeamStore } from '../../data/team-store';
import { HistoryStore } from '../../data/history-store';
import { RouterLink } from '@angular/router';
import { Dialogs } from '../../shared/dialogs';
import { ChatMarkdown } from '../chat/chat-markdown';
import {
  atMinute,
  dayFromIso,
  DAY_MS,
  dayOf,
  deviceZone,
  isoDay,
  minuteOf,
  weekdayName,
} from './cal-util';

/** What the dialog opens on: an event (and the occurrence the person clicked), or a new one in a time range. */
export interface EventDialogData {
  eventId?: string;
  /** The `originalStart` of the occurrence of a repeating event that was clicked. */
  occurrence?: string;
  /** That occurrence's start and end (instants), as drawn. */
  startMs?: number;
  endMs?: number;
  seed?: { startMs: number; endMs: number; allDay: boolean; spaceId?: string };
  /** The zone the calendar is shown in: where a new event starts. */
  tz: string;
}

const KNOWN_ERRORS = [
  'invalid_time',
  'end_before_start',
  'event_too_long',
  'invalid_timezone',
  'all_day_not_midnight',
  'invalid_rrule',
  'forbidden',
  'not_found',
  'read_only',
  'offline',
  'quota_exceeded',
  'not_a_member',
  'cannot_view_calendar',
  'invalid_role',
  'too_many_attendees',
  'no_attendees_in_personal',
  'too_many_exceptions',
  'occurrence_required',
  'not_an_occurrence',
  'scope_this_fields',
  'too_many_events',
  'unsupported_scope',
  'title_required',
  'invalid',
];

export const calErrKey = (code: string): string =>
  'calendar.err.' +
  (KNOWN_ERRORS.includes(code) ? code : code.startsWith('rrule') ? 'invalid_rrule' : 'error');

export const calErr = (e: unknown): string =>
  calErrKey(e instanceof CalendarError ? e.code : toProblem(e).code);

export const REMINDER_CHOICES = [0, 5, 10, 15, 30, 60, 120, 1440];

// ---------------------------------------------------------------- which occurrences?

/** Asks which occurrences of a repeating event a change is for. Closes with the scope, or nothing when the person backs out. */
@Component({
  selector: 'app-scope-dialog',
  imports: [FormsModule, MatDialogModule, MatButtonModule, TranslocoPipe],
  template: `
    <h2 mat-dialog-title>{{ 'calendar.scope.title' | transloco }}</h2>
    <mat-dialog-content>
      <p class="muted">{{ 'calendar.scope.' + data.action | transloco }}</p>
      <div class="opts" role="radiogroup">
        @for (s of scopes; track s) {
          <label class="opt"
            ><input
              type="radio"
              name="scope"
              [value]="s"
              [(ngModel)]="scope"
              [attr.data-scope]="s"
            />{{ 'calendar.scope.' + s | transloco }}</label
          >
        }
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" mat-dialog-close>{{ 'common.cancel' | transloco }}</button>
      <button mat-flat-button type="button" [mat-dialog-close]="scope" data-action="scope-ok">
        {{ 'common.ok' | transloco }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .opts {
      display: grid;
      gap: 8px;
      margin-top: 8px;
    }
    .opt {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .muted {
      color: var(--text-dim);
    }
  `,
})
export class ScopeDialog {
  protected readonly data = inject<{ action: 'edit' | 'cancel' | 'move'; allowFollowing: boolean }>(
    MAT_DIALOG_DATA,
  );
  protected scope: EditScope = 'this';
  protected readonly scopes: EditScope[] = this.data.allowFollowing
    ? ['this', 'following', 'all']
    : ['this', 'all'];
}

// ---------------------------------------------------------------- the event

/**
 * One event: made here, changed here, or only looked at. Somebody who may change it gets the form; everybody on it gets the answer
 * buttons, their own reminders and the list of who else is coming. A repeating event asks which occurrences a change is for.
 */
@Component({
  selector: 'app-event-dialog',
  imports: [
    FormsModule,
    RouterLink,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    TranslocoPipe,
    ChatMarkdown,
  ],
  template: `
    <h2 mat-dialog-title>
      {{
        (isNew ? 'calendar.newEvent' : editable() ? 'calendar.editEvent' : 'calendar.event')
          | transloco
      }}
    </h2>
    <mat-dialog-content data-event-dialog>
      @if (!editable()) {
        <!-- read only: what it is, when, who -->
        <h3 class="ro-title" data-ro-title>{{ title() }}</h3>
        <p class="when" data-ro-when>{{ whenText() }}</p>
        @if (rruleText()) {
          <p class="muted">{{ rruleText() }}</p>
        }
        @if (location()) {
          <p><mat-icon class="in">place</mat-icon>{{ location() }}</p>
        }
        @if (safeVideo()) {
          <p>
            <mat-icon class="in">videocam</mat-icon
            ><a [href]="safeVideo()" target="_blank" rel="noopener noreferrer nofollow">{{
              videoUrl()
            }}</a>
          </p>
        }
        @if (description()) {
          <app-chat-markdown [text]="description()" />
        }
        @if (event()?.me?.addedByName; as by) {
          <p class="muted" data-who-added>{{ 'calendar.addedBy' | transloco: { name: by } }}</p>
        }
      } @else {
        <div class="row">
          <input
            type="text"
            class="grow big"
            [ngModel]="title()"
            (ngModelChange)="title.set($event)"
            [placeholder]="'calendar.titlePlaceholder' | transloco"
            [attr.aria-label]="'calendar.titleField' | transloco"
            maxlength="200"
            data-field="title"
          />
        </div>
        <div class="row">
          <label
            ><input
              type="radio"
              name="kind"
              value="meeting"
              [ngModel]="kind()"
              (ngModelChange)="kind.set($event)"
            />{{ 'calendar.kind.meeting' | transloco }}</label
          >
          <label
            ><input
              type="radio"
              name="kind"
              value="event"
              [ngModel]="kind()"
              (ngModelChange)="kind.set($event)"
            />{{ 'calendar.kind.event' | transloco }}</label
          >
          @if (isNew && spaces().length > 1) {
            <select
              [ngModel]="spaceId()"
              (ngModelChange)="setSpace($event)"
              [attr.aria-label]="'calendar.space' | transloco"
              data-field="space"
            >
              @for (s of spaces(); track s.id) {
                <option [value]="s.id">{{ s.name }}</option>
              }
            </select>
          }
        </div>
        <div class="row">
          <label class="chk"
            ><input
              type="checkbox"
              [ngModel]="allDay()"
              (ngModelChange)="allDay.set($event)"
              data-field="all-day"
            />{{ 'calendar.allDay' | transloco }}</label
          >
        </div>
        <div class="row when-row">
          <input
            type="date"
            [ngModel]="startDay()"
            (ngModelChange)="startMoved($event)"
            [attr.aria-label]="'calendar.start' | transloco"
            data-field="start-date"
          />
          @if (!allDay()) {
            <input
              type="time"
              [ngModel]="startTime()"
              (ngModelChange)="startTime.set($event)"
              step="300"
              [attr.aria-label]="'calendar.startTime' | transloco"
              data-field="start-time"
            />
          }
          <span>→</span>
          @if (!allDay()) {
            <input
              type="time"
              [ngModel]="endTime()"
              (ngModelChange)="endTime.set($event)"
              step="300"
              [attr.aria-label]="'calendar.endTime' | transloco"
              data-field="end-time"
            />
          }
          <input
            type="date"
            [ngModel]="endDay()"
            (ngModelChange)="endDay.set($event)"
            [attr.aria-label]="'calendar.end' | transloco"
            data-field="end-date"
          />
        </div>
        @if (!allDay()) {
          <div class="row">
            <mat-icon class="in">public</mat-icon>
            <input
              type="text"
              class="grow"
              list="tz-list"
              [ngModel]="tz()"
              (ngModelChange)="tz.set($event)"
              [attr.aria-label]="'calendar.timezone' | transloco"
              data-field="timezone"
            />
            <datalist id="tz-list">
              @for (z of zones; track z) {
                <option [value]="z"></option>
              }
            </datalist>
          </div>
        }
        <div class="row">
          <mat-icon class="in">repeat</mat-icon>
          <select
            [ngModel]="preset()"
            (ngModelChange)="preset.set($event)"
            [attr.aria-label]="'calendar.repeat' | transloco"
            data-field="repeat"
          >
            @for (p of presets; track p) {
              <option [value]="p">{{ 'calendar.repeatPreset.' + p | transloco }}</option>
            }
          </select>
        </div>
        @if (preset() === 'custom') {
          <div class="custom" data-custom-repeat>
            <div class="row">
              {{ 'calendar.every' | transloco }}
              <input
                type="number"
                min="1"
                max="999"
                [ngModel]="interval()"
                (ngModelChange)="interval.set($event)"
                data-field="interval"
              />
              <select
                [ngModel]="freq()"
                (ngModelChange)="freq.set($event)"
                [attr.aria-label]="'calendar.repeat' | transloco"
                data-field="freq"
              >
                @for (f of freqs; track f) {
                  <option [value]="f">{{ 'calendar.unit.' + f | transloco }}</option>
                }
              </select>
            </div>
            @if (freq() === 'WEEKLY') {
              <div class="row days">
                @for (d of weekOrder; track d) {
                  <button
                    type="button"
                    class="day"
                    [class.on]="weekdays().includes(d)"
                    (click)="toggleDay(d)"
                    [attr.aria-pressed]="weekdays().includes(d)"
                    [attr.data-day]="d"
                  >
                    {{ dayName(d) }}
                  </button>
                }
              </div>
            }
            @if (freq() === 'MONTHLY') {
              <div class="row">
                <select
                  [ngModel]="monthMode()"
                  (ngModelChange)="monthMode.set($event)"
                  [attr.aria-label]="'calendar.monthMode' | transloco"
                  data-field="month-mode"
                >
                  <option value="day">
                    {{ 'calendar.onDay' | transloco: { day: startDom() } }}
                  </option>
                  <option value="nth">
                    {{
                      'calendar.onNth' | transloco: { nth: nthLabel(), day: dayName(startDow()) }
                    }}
                  </option>
                  @if (isLastWeekday()) {
                    <option value="last">
                      {{ 'calendar.onLast' | transloco: { day: dayName(startDow()) } }}
                    </option>
                  }
                </select>
              </div>
            }
            <div class="row">
              <select
                [ngModel]="ends()"
                (ngModelChange)="ends.set($event)"
                [attr.aria-label]="'calendar.ends' | transloco"
                data-field="ends"
              >
                <option value="never">{{ 'calendar.endsNever' | transloco }}</option>
                <option value="count">{{ 'calendar.endsCount' | transloco }}</option>
                <option value="until">{{ 'calendar.endsUntil' | transloco }}</option>
              </select>
              @if (ends() === 'count') {
                <input
                  type="number"
                  min="1"
                  max="3650"
                  [ngModel]="count()"
                  (ngModelChange)="count.set($event)"
                  data-field="count"
                />
              }
              @if (ends() === 'until') {
                <input
                  type="date"
                  [ngModel]="untilDay()"
                  (ngModelChange)="untilDay.set($event)"
                  data-field="until"
                />
              }
            </div>
          </div>
        }
        @if (rruleText()) {
          <p class="muted rtext" data-rrule-text>{{ rruleText() }}</p>
        }
        <div class="row">
          <mat-icon class="in">place</mat-icon>
          <input
            type="text"
            class="grow"
            [ngModel]="location()"
            (ngModelChange)="location.set($event)"
            [placeholder]="'calendar.location' | transloco"
            [attr.aria-label]="'calendar.location' | transloco"
            maxlength="300"
            data-field="location"
          />
        </div>
        <div class="row">
          <mat-icon class="in">videocam</mat-icon>
          <input
            type="url"
            class="grow"
            [ngModel]="videoUrl()"
            (ngModelChange)="videoUrl.set($event)"
            [placeholder]="'calendar.videoUrl' | transloco"
            [attr.aria-label]="'calendar.videoUrl' | transloco"
            maxlength="500"
            data-field="video"
          />
        </div>
        @if (!isPersonal()) {
          <div class="row">
            <mat-icon class="in">visibility</mat-icon>
            <select
              [ngModel]="visibility()"
              (ngModelChange)="visibility.set($event)"
              [attr.aria-label]="'calendar.visibility' | transloco"
              data-field="visibility"
            >
              <option value="attendees">{{ 'calendar.visibilityAttendees' | transloco }}</option>
              <option value="space">{{ 'calendar.visibilitySpace' | transloco }}</option>
            </select>
          </div>
        }
        <div class="row">
          <textarea
            [ngModel]="description()"
            (ngModelChange)="description.set($event)"
            [placeholder]="'calendar.description' | transloco"
            [attr.aria-label]="'calendar.description' | transloco"
            maxlength="10000"
            data-field="description"
          ></textarea>
        </div>
      }

      <!-- people -->
      @if (!isPersonal()) {
        <h3>{{ 'calendar.people' | transloco }}</h3>
        @if (detail(); as d) {
          <ul class="people" data-attendees>
            @for (a of d.attendees; track a.kind + a.subjectId) {
              <li [attr.data-attendee]="a.subjectId" [attr.data-status]="a.status">
                <mat-icon class="in">{{ a.kind === 'role' ? 'shield' : 'person' }}</mat-icon>
                <span class="grow"
                  >{{ a.name }}
                  @if (a.kind === 'role') {
                    <span class="muted"> · {{ a.memberCount }}</span>
                  }
                  @if (a.optional) {
                    <span class="muted"> · {{ 'calendar.optional' | transloco }}</span>
                  }
                </span>
                <span class="status s-{{ a.status }}">{{ 'rsvp.' + a.status | transloco }}</span>
                @if (d.canEdit && a.subjectId !== event()?.ownerId) {
                  <button
                    type="button"
                    class="icon"
                    (click)="removePerson(a.kind, a.subjectId)"
                    [attr.aria-label]="'common.delete' | transloco"
                    data-action="remove-attendee"
                  >
                    <mat-icon>close</mat-icon>
                  </button>
                }
              </li>
            }
          </ul>
        } @else if (!isNew && event()) {
          <p class="muted">{{ 'calendar.peopleOffline' | transloco }}</p>
        }
        @if (isNew || detail()?.canEdit) {
          <div class="picker" data-attendee-picker [attr.data-only-me]="noOne() ? '' : null">
            @if (peopleError()) {
              <p class="muted">{{ 'calendar.peopleOffline' | transloco }}</p>
            } @else if (noOne()) {
              <p class="muted" data-only-me>{{ 'calendar.onlyMe' | transloco }}</p>
            } @else {
              <input
                type="text"
                class="grow"
                [ngModel]="filter()"
                (ngModelChange)="filter.set($event)"
                [placeholder]="'calendar.findPeople' | transloco"
                [attr.aria-label]="'calendar.findPeople' | transloco"
                data-field="people-filter"
              />
              <div class="options">
                @for (r of shownRoles(); track r.id) {
                  <label class="opt"
                    ><input
                      type="checkbox"
                      [checked]="isChosen('role', r.id)"
                      (change)="choose('role', r.id, $any($event.target).checked)"
                      [attr.data-role]="r.id"
                    /><mat-icon class="in">shield</mat-icon>{{ r.name }}
                    <span class="muted">· {{ r.memberCount }}</span></label
                  >
                }
                @for (u of shownUsers(); track u.userId) {
                  <label class="opt"
                    ><input
                      type="checkbox"
                      [checked]="isChosen('user', u.userId)"
                      (change)="choose('user', u.userId, $any($event.target).checked)"
                      [attr.data-person]="u.userId"
                    /><mat-icon class="in">person</mat-icon>{{ u.displayName }}</label
                  >
                }
              </div>
              @if (!isNew && chosen().length) {
                <button
                  mat-stroked-button
                  type="button"
                  (click)="addChosen()"
                  data-action="add-people"
                >
                  {{ 'calendar.addPeople' | transloco }}
                </button>
              }
            }
          </div>
        }
      }

      <!-- my answer, my reminders -->
      @if (event(); as ev) {
        @if (ev.me && !ev.deletedAt) {
          <h3>{{ 'rsvp.title' | transloco }}</h3>
          <div class="row rsvp" data-rsvp-bar>
            @if (ev.me.addedByName && editable()) {
              <span class="muted" data-who-added>{{
                'calendar.addedBy' | transloco: { name: ev.me.addedByName }
              }}</span>
            }
            @for (s of answers; track s) {
              <button
                mat-stroked-button
                type="button"
                [class.on]="ev.me.status === s"
                (click)="answer(s)"
                [attr.data-rsvp]="s"
                [attr.aria-pressed]="ev.me.status === s"
              >
                {{ 'rsvp.' + s | transloco }}
              </button>
            }
            <span class="muted" data-my-status>{{ 'rsvp.' + ev.me.status | transloco }}</span>
          </div>
          <h3>{{ 'reminder.title' | transloco }}</h3>
          <div class="row" data-reminders>
            <label class="chk"
              ><input
                type="checkbox"
                [checked]="reminders() === null"
                (change)="useDefaults($any($event.target).checked)"
                data-field="reminder-default"
              />{{ 'reminder.useDefaults' | transloco }}</label
            >
            @if (reminders() !== null) {
              @for (m of reminderChoices; track m) {
                <button
                  type="button"
                  class="day"
                  [class.on]="reminders()!.includes(m)"
                  (click)="toggleReminder(m)"
                  [attr.aria-pressed]="reminders()!.includes(m)"
                  [attr.data-reminder]="m"
                >
                  {{ minutesLabel(m) }}
                </button>
              }
            }
          </div>
        }
      } @else if (isNew) {
        <h3>{{ 'reminder.title' | transloco }}</h3>
        <div class="row" data-reminders>
          <label class="chk"
            ><input
              type="checkbox"
              [checked]="reminders() === null"
              (change)="useDefaults($any($event.target).checked)"
            />{{ 'reminder.useDefaults' | transloco }}</label
          >
          @if (reminders() !== null) {
            @for (m of reminderChoices; track m) {
              <button
                type="button"
                class="day"
                [class.on]="reminders()!.includes(m)"
                (click)="toggleReminder(m)"
                [attr.aria-pressed]="reminders()!.includes(m)"
              >
                {{ minutesLabel(m) }}
              </button>
            }
          }
        </div>
      }
      @if (error()) {
        <p class="err" role="alert" data-error>{{ error() | transloco }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (!isNew && history.forEntity(data.eventId!).length) {
        <a mat-button routerLink="/app/history" [queryParams]="{ entity: data.eventId }" data-action="show-history">{{ 'history.showMine' | transloco }}</a>
      }
      @if (!isNew && editable()) {
        <button mat-button type="button" (click)="duplicate()" data-action="duplicate-event">
          {{ 'calendar.duplicate' | transloco }}
        </button>
        <button
          mat-button
          type="button"
          class="danger"
          (click)="cancelEvent()"
          data-action="cancel-event"
        >
          {{ 'calendar.cancelEvent' | transloco }}
        </button>
      }
      <span class="grow"></span>
      <button mat-button type="button" mat-dialog-close data-action="close">
        {{ 'common.close' | transloco }}
      </button>
      @if (editable()) {
        <button
          mat-flat-button
          type="button"
          (click)="save()"
          [disabled]="busy()"
          data-action="save-event"
        >
          {{ 'common.save' | transloco }}
        </button>
      }
    </mat-dialog-actions>
  `,
  styles: `
    mat-dialog-content {
      min-width: min(560px, 82vw);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 8px 0;
      flex-wrap: wrap;
    }
    .row input[type='text'],
    .row input[type='url'],
    .row input[type='number'],
    .row input[type='date'],
    .row input[type='time'],
    .row select,
    textarea,
    .picker input {
      font: inherit;
      color: inherit;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px 8px;
    }
    .row input[type='number'] {
      width: 70px;
    }
    .grow {
      flex: 1;
      min-width: 120px;
    }
    .big {
      font-size: 18px;
    }
    textarea {
      width: 100%;
      box-sizing: border-box;
      min-height: 90px;
    }
    .in {
      font-size: 20px;
      width: 20px;
      height: 20px;
      color: var(--text-dim);
      flex: none;
    }
    .muted {
      color: var(--text-dim);
      font-size: 13px;
    }
    .chk {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    h3 {
      margin: 18px 0 4px;
      font-size: 14px;
    }
    .ro-title {
      margin: 0 0 4px;
      font-size: 20px;
    }
    .when {
      margin: 0 0 8px;
    }
    .days,
    .custom .row {
      gap: 6px;
    }
    .day {
      font: inherit;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      border-radius: 14px;
      padding: 2px 10px;
      cursor: pointer;
    }
    .day.on {
      background: var(--mat-sys-primary);
      color: var(--mat-sys-on-primary);
      border-color: transparent;
    }
    .people {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .people li {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 3px 0;
    }
    .status {
      font-size: 12px;
      padding: 1px 8px;
      border-radius: 10px;
      background: var(--surface-3);
    }
    .s-accepted {
      background: color-mix(in srgb, #22c55e 30%, var(--surface));
    }
    .s-declined {
      background: color-mix(in srgb, #ef4444 30%, var(--surface));
    }
    .s-tentative {
      background: color-mix(in srgb, #eab308 35%, var(--surface));
    }
    .picker .options {
      max-height: 160px;
      overflow: auto;
      margin: 6px 0;
      display: grid;
      gap: 2px;
    }
    .opt {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .rsvp .on {
      background: var(--surface-3);
      border-color: var(--mat-sys-primary);
    }
    .err {
      color: var(--mat-sys-error);
    }
    .danger {
      color: var(--mat-sys-error);
    }
    button.icon {
      background: none;
      border: 0;
      color: var(--text-dim);
      cursor: pointer;
      padding: 2px;
      border-radius: 6px;
      display: grid;
      place-items: center;
    }
    button.icon:hover {
      background: var(--surface-3);
    }
    .rtext {
      margin: 0 0 4px 28px;
    }
  `,
})
export class EventDialog {
  protected readonly data = inject<EventDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<EventDialog>>(MatDialogRef);
  private readonly store = inject(CalendarStore);
  protected readonly history = inject(HistoryStore);
  private readonly teams = inject(TeamStore);
  private readonly lang = inject(Language);
  private readonly notify = inject(Notify);
  private readonly dialog = inject(MatDialog);
  private readonly dialogs = inject(Dialogs);

  protected readonly isNew = !this.data.eventId;
  protected readonly event = signal<EventDto | null>(
    this.data.eventId ? (this.store.eventById().get(this.data.eventId) ?? null) : null,
  );
  protected readonly detail = signal<EventDetailDto | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  protected readonly presets: readonly RepeatPreset[] = [
    'none',
    'daily',
    'weekdays',
    'weekly',
    'monthly',
    'yearly',
    'custom',
  ];
  protected readonly freqs = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'] as const;
  protected readonly answers: readonly RsvpAnswer[] = ['accepted', 'tentative', 'declined'];
  protected readonly reminderChoices = REMINDER_CHOICES;
  protected readonly zones: readonly string[] = (() => {
    try {
      return (
        (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
          'timeZone',
        ) ?? [deviceZone()]
      );
    } catch {
      return [deviceZone()];
    }
  })();
  protected readonly weekOrder = [1, 2, 3, 4, 5, 6, 0];

  // the form
  protected readonly title = signal('');
  protected readonly kind = signal<'meeting' | 'event'>('meeting');
  protected readonly spaceId = signal('');
  protected readonly allDay = signal(false);
  protected readonly startDay = signal('');
  protected readonly startTime = signal('09:00');
  protected readonly endDay = signal('');
  protected readonly endTime = signal('10:00');
  protected readonly tz = signal('UTC');
  protected readonly preset = signal<RepeatPreset>('none');
  protected readonly freq = signal<'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'>('WEEKLY');
  protected readonly interval = signal(1);
  protected readonly weekdays = signal<number[]>([]);
  protected readonly monthMode = signal<'day' | 'nth' | 'last'>('day');
  protected readonly ends = signal<'never' | 'count' | 'until'>('never');
  protected readonly count = signal(10);
  protected readonly untilDay = signal('');
  protected readonly location = signal('');
  protected readonly videoUrl = signal('');
  protected readonly visibility = signal<'attendees' | 'space'>('attendees');
  protected readonly description = signal('');
  protected readonly reminders = signal<number[] | null>(null);

  // people
  protected readonly people = signal<CalendarPeopleDto | null>(null);
  protected readonly peopleError = signal(false);
  protected readonly filter = signal('');
  protected readonly chosen = signal<AttendeeInput[]>([]);

  /** The spaces a new event can go in: the person's own calendar, and every team or project where they may make meetings. */
  protected readonly spaces = computed(() => {
    const out: { id: string; name: string }[] = [];
    const personal = this.store.personalSpaceId();
    if (personal) out.push({ id: personal, name: this.lang.t('calendar.personal') });
    for (const t of this.teams.teams() ?? [])
      if (this.store.can(t.spaceId, Permission.CREATE_MEETINGS))
        out.push({ id: t.spaceId, name: t.name });
    for (const p of this.teams.projects())
      if (this.store.can(p.spaceId, Permission.CREATE_MEETINGS))
        out.push({
          id: p.spaceId,
          name: `${this.teams.teamById().get(p.teamId)?.name ?? ''} / ${p.name}`,
        });
    return out;
  });

  protected readonly editable = computed(() => {
    const e = this.event();
    return this.isNew ? true : !!e && !e.deletedAt && this.store.canEdit(e);
  });
  protected readonly isPersonal = computed(() => this.store.isPersonalSpace(this.spaceId()));

  private readonly startDate = computed(() => dayFromIso(this.startDay()));
  protected readonly startDow = computed(() => ((this.startDate() ?? 0) + 4) % 7); // day 0 was a Thursday
  protected readonly startDom = computed(() => Number(this.startDay().slice(8, 10)) || 1);
  protected readonly nthLabel = computed(() =>
    this.lang.t(`rrule.nth.${Math.ceil(this.startDom() / 7)}`),
  );
  protected readonly isLastWeekday = computed(() => this.startDom() + 7 > this.daysInMonth());
  private readonly daysInMonth = computed(() => {
    const y = Number(this.startDay().slice(0, 4));
    const m = Number(this.startDay().slice(5, 7));
    return y && m ? new Date(Date.UTC(y, m, 0)).getUTCDate() : 31;
  });

  protected readonly noOne = computed(
    () => !this.people() || (!this.people()!.users.length && !this.people()!.roles.length),
  );
  protected readonly shownUsers = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const have = new Set(
      this.detail()
        ?.attendees.filter((a) => a.kind === 'user')
        .map((a) => a.subjectId) ?? [],
    );
    return (this.people()?.users ?? []).filter(
      (u) => !have.has(u.userId) && (!q || u.displayName.toLowerCase().includes(q)),
    );
  });
  protected readonly shownRoles = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const have = new Set(
      this.detail()
        ?.attendees.filter((a) => a.kind === 'role')
        .map((a) => a.subjectId) ?? [],
    );
    return (this.people()?.roles ?? []).filter(
      (r) => !have.has(r.id) && (!q || r.name.toLowerCase().includes(q)),
    );
  });

  /** What the repeat picker was left showing when the event was opened: if it still shows that, the rule the event has is kept as it is (the picker cannot say everything a rule can). */
  private initialBuilt: string | null | undefined;
  private readonly rruleNow = computed<string | null>(() => {
    const built = this.buildRule();
    return this.initialBuilt !== undefined && built === this.initialBuilt
      ? (this.event()?.rrule ?? null)
      : built;
  });
  protected readonly rruleText = computed(() => {
    const text = this.editable() ? this.rruleNow() : (this.event()?.rrule ?? null);
    return text
      ? describeRRule(
          text,
          (k, p) => this.lang.t(k, p),
          (ms) => this.lang.date(new Date(ms)),
        )
      : '';
  });
  protected readonly safeVideo = computed(() =>
    /^https?:\/\//i.test(this.videoUrl()) ? this.videoUrl() : '',
  );
  protected readonly whenText = computed(() => {
    const e = this.event();
    const s = this.data.startMs ?? (e ? new Date(e.startAt).getTime() : 0);
    const en = this.data.endMs ?? (e ? new Date(e.endAt).getTime() : 0);
    if (!e) return '';
    const lang = this.lang.current === 'pt' ? 'pt-PT' : 'en-GB';
    if (e.allDay) {
      const f = (ms: number) =>
        new Intl.DateTimeFormat(lang, { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(ms));
      return en - s > DAY_MS ? `${f(s)} → ${f(en - DAY_MS)}` : f(s);
    }
    const f = new Intl.DateTimeFormat(lang, {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: this.data.tz,
    });
    return `${f.format(new Date(s))} → ${new Intl.DateTimeFormat(lang, { timeStyle: 'short', timeZone: this.data.tz }).format(new Date(en))}`;
  });

  constructor() {
    const e = this.event();
    if (e) this.fillFrom(e);
    else this.fillNew();
    if (this.editable()) void this.loadPeople();
    if (e) void this.loadDetail(e.id);
  }

  // ---------------------------------------------------------------- filling the form

  private fillNew(): void {
    const seed = this.data.seed!;
    const spaces = this.spaces();
    this.spaceId.set(
      seed.spaceId && spaces.some((s) => s.id === seed.spaceId)
        ? seed.spaceId
        : (spaces[0]?.id ?? ''),
    );
    const tz = this.store.settings().defaultTz ?? this.data.tz;
    this.tz.set(tz);
    this.allDay.set(seed.allDay);
    this.setTimes(seed.startMs, seed.endMs, seed.allDay, tz);
    this.reminders.set(null);
  }

  private fillFrom(e: EventDto): void {
    this.title.set(e.title);
    this.kind.set(e.kind);
    this.spaceId.set(e.spaceId);
    this.allDay.set(e.allDay);
    this.tz.set(e.timezone);
    this.location.set(e.location ?? '');
    this.videoUrl.set(e.videoUrl ?? '');
    this.visibility.set(e.visibility);
    this.description.set(e.description);
    const s = this.data.startMs ?? new Date(e.startAt).getTime();
    const en = this.data.endMs ?? new Date(e.endAt).getTime();
    this.setTimes(s, en, e.allDay, e.timezone);
    this.readRule(e.rrule);
    this.initialBuilt = this.buildRule();
  }

  private setTimes(startMs: number, endMs: number, allDay: boolean, tz: string): void {
    if (allDay) {
      this.startDay.set(isoDay(dayOf(startMs, 'UTC')));
      this.endDay.set(isoDay(dayOf(Math.max(startMs, endMs - 1), 'UTC')));
      return;
    }
    const pad = (n: number) => String(n).padStart(2, '0');
    const hm = (ms: number) =>
      `${pad(Math.floor(minuteOf(ms, tz) / 60))}:${pad(minuteOf(ms, tz) % 60)}`;
    this.startDay.set(isoDay(dayOf(startMs, tz)));
    this.startTime.set(hm(startMs));
    this.endDay.set(isoDay(dayOf(endMs, tz)));
    this.endTime.set(hm(endMs));
  }

  private readRule(text: string | null): void {
    const dow = this.startDow();
    const dom = this.startDom();
    const preset = presetOf(text, dow, dom);
    this.preset.set(preset);
    if (preset !== 'custom') return;
    const p = text ? parseRRule(text) : null;
    if (!p?.ok) return;
    const r = p.rule;
    this.freq.set(r.freq);
    this.interval.set(r.interval);
    this.weekdays.set(r.byDay?.map((b) => b.day) ?? [dow]);
    if (r.freq === 'MONTHLY')
      this.monthMode.set(r.byDay?.[0]?.ord === -1 ? 'last' : r.byDay?.length ? 'nth' : 'day');
    if (r.count !== undefined) {
      this.ends.set('count');
      this.count.set(r.count);
    } else if (r.until !== undefined) {
      this.ends.set('until');
      this.untilDay.set(isoDay(dayOf(r.until, 'UTC')));
    }
  }

  // ---------------------------------------------------------------- reading the form

  private buildRule(): string | null {
    const preset = this.preset();
    if (preset === 'none') return null;
    if (preset !== 'custom') return ruleOfPreset(preset, this.startDow());
    const rule: RRule = {
      freq: this.freq(),
      interval: Math.max(1, Math.min(999, Math.round(this.interval() || 1))),
      wkst: 1,
    };
    if (rule.freq === 'WEEKLY')
      rule.byDay = (this.weekdays().length ? this.weekdays() : [this.startDow()]).map((day) => ({
        day,
      }));
    if (rule.freq === 'MONTHLY' && this.monthMode() !== 'day')
      rule.byDay = [
        {
          day: this.startDow(),
          ord: this.monthMode() === 'last' ? -1 : Math.ceil(this.startDom() / 7),
        },
      ];
    if (this.ends() === 'count')
      rule.count = Math.max(1, Math.min(3650, Math.round(this.count() || 1)));
    if (this.ends() === 'until') {
      const d = dayFromIso(this.untilDay());
      if (d !== null) rule.until = d * DAY_MS + DAY_MS - 1000;
    }
    return formatRRule(rule);
  }

  private instants(): { startMs: number; endMs: number } | null {
    const s = dayFromIso(this.startDay());
    const e = dayFromIso(this.endDay());
    if (s === null || e === null) return null;
    if (this.allDay()) return { startMs: s * DAY_MS, endMs: (e + 1) * DAY_MS };
    const tz = this.tz();
    if (!isValidTimeZone(tz)) return null;
    const m = (t: string) => {
      const x = /^(\d{2}):(\d{2})$/.exec(t);
      return x ? Number(x[1]) * 60 + Number(x[2]) : null;
    };
    const a = m(this.startTime());
    const b = m(this.endTime());
    if (a === null || b === null) return null;
    return { startMs: atMinute(s, a, tz), endMs: atMinute(e, b, tz) };
  }

  protected dayName(d: number): string {
    return weekdayName(d, this.lang.current);
  }
  protected minutesLabel(m: number): string {
    return m === 0
      ? this.lang.t('reminder.atStart')
      : m >= 1440
        ? this.lang.t('reminder.days', { n: m / 1440 })
        : m >= 60
          ? this.lang.t('reminder.hours', { n: m / 60 })
          : this.lang.t('reminder.minutes', { n: m });
  }

  protected startMoved(day: string): void {
    // keep the length: moving the start day moves the end day with it
    const before = dayFromIso(this.startDay());
    const after = dayFromIso(day);
    const end = dayFromIso(this.endDay());
    this.startDay.set(day);
    if (before !== null && after !== null && end !== null)
      this.endDay.set(isoDay(end + (after - before)));
  }

  protected toggleDay(d: number): void {
    this.weekdays.update((list) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d]));
  }

  protected toggleReminder(m: number): void {
    this.reminders.update((list) =>
      (list ?? []).includes(m)
        ? (list ?? []).filter((x) => x !== m)
        : [...(list ?? []), m].sort((a, b) => a - b).slice(0, 5),
    );
    this.persistReminders();
  }
  protected useDefaults(on: boolean): void {
    this.reminders.set(on ? null : []);
    this.persistReminders();
  }
  private persistReminders(): void {
    const e = this.event();
    if (e)
      void this.store
        .setReminders(e.id, this.reminders())
        .catch(() => this.error.set('calendar.err.offline'));
  }

  // ---------------------------------------------------------------- people

  protected setSpace(id: string): void {
    this.spaceId.set(id);
    this.chosen.set([]);
    void this.loadPeople();
  }

  private async loadPeople(): Promise<void> {
    const space = this.spaceId();
    if (!space || this.store.isPersonalSpace(space)) return void this.people.set(null);
    try {
      this.people.set(await this.store.people(space));
      this.peopleError.set(false);
    } catch {
      this.peopleError.set(true);
    }
  }

  private async loadDetail(id: string): Promise<void> {
    try {
      const d = await this.store.detail(id);
      this.detail.set(d);
      this.event.set(d.event);
      this.reminders.set(d.reminders);
    } catch {
      /* offline: what this device holds is shown */
    }
  }

  protected isChosen(kind: 'user' | 'role', id: string): boolean {
    return this.chosen().some((c) => c.kind === kind && c.subjectId === id);
  }
  protected choose(kind: 'user' | 'role', id: string, on: boolean): void {
    this.chosen.update((list) =>
      on
        ? [...list, { kind, subjectId: id }]
        : list.filter((c) => !(c.kind === kind && c.subjectId === id)),
    );
  }

  protected async addChosen(): Promise<void> {
    const e = this.event();
    if (!e || !this.chosen().length) return;
    try {
      const d = await this.store.addAttendees(e.id, this.chosen());
      this.detail.set(d);
      this.event.set(d.event);
      this.chosen.set([]);
      await this.loadPeople();
    } catch (err) {
      this.error.set(calErr(err));
    }
  }

  protected async removePerson(kind: 'user' | 'role', id: string): Promise<void> {
    const e = this.event();
    if (!e) return;
    try {
      const d = await this.store.removeAttendee(e.id, kind, id);
      this.detail.set(d);
      this.event.set(d.event);
      await this.loadPeople();
    } catch (err) {
      this.error.set(calErr(err));
    }
  }

  protected async answer(status: RsvpAnswer): Promise<void> {
    const e = this.event();
    if (!e) return;
    try {
      await this.store.rsvp(e.id, status);
      this.event.set(this.store.eventById().get(e.id) ?? null);
      void this.loadDetail(e.id);
    } catch (err) {
      this.error.set(calErr(err));
    }
  }

  // ---------------------------------------------------------------- saving

  private askScope(action: 'edit' | 'cancel' | 'move'): Promise<EditScope | null> {
    return new Promise((resolve) => {
      const ref = this.dialog.open<
        ScopeDialog,
        { action: typeof action; allowFollowing: boolean },
        EditScope
      >(ScopeDialog, { data: { action, allowFollowing: navigator.onLine } });
      ref.afterClosed().subscribe((s) => resolve(s ?? null));
    });
  }

  protected async save(): Promise<void> {
    this.error.set('');
    const title = this.title().trim();
    if (!title) return void this.error.set('calendar.err.title_required');
    const when = this.instants();
    if (!when) return void this.error.set('calendar.err.invalid_time');
    const rrule = this.rruleNow();
    const timing = normalizeTiming({
      startAt: new Date(when.startMs).toISOString(),
      endAt: new Date(when.endMs).toISOString(),
      allDay: this.allDay(),
      timezone: this.tz(),
      rrule,
    });
    if (!timing.ok) return void this.error.set(calErrKey(timing.error));
    this.busy.set(true);
    try {
      const e = this.event();
      const common = {
        kind: this.kind(),
        title,
        description: this.description(),
        location: this.location().trim() || null,
        videoUrl: this.videoUrl().trim() || null,
        visibility: this.isPersonal() ? ('attendees' as const) : this.visibility(),
      };
      if (!e) {
        await this.store.createEvent({
          spaceId: this.spaceId(),
          ...common,
          startAt: timing.value.startAt,
          endAt: timing.value.endAt,
          allDay: timing.value.allDay,
          timezone: timing.value.timezone,
          rrule: timing.value.rrule,
          ...(this.chosen().length ? { attendees: this.chosen() } : {}),
          ...(this.reminders() !== null ? { reminders: this.reminders()! } : {}),
        });
        return void this.ref.close(true);
      }
      await this.saveExisting(e, common, timing.value, when);
      this.ref.close(true);
    } catch (err) {
      this.error.set(calErr(err));
    } finally {
      this.busy.set(false);
    }
  }

  private async saveExisting(
    e: EventDto,
    common: Record<string, unknown>,
    timing: {
      startAt: string;
      endAt: string;
      allDay: boolean;
      timezone: string;
      rrule: string | null;
    },
    when: { startMs: number; endMs: number },
  ): Promise<void> {
    const occStart = this.data.startMs ?? new Date(e.startAt).getTime();
    const occEnd = this.data.endMs ?? new Date(e.endAt).getTime();
    const timeChanged = when.startMs !== occStart || when.endMs !== occEnd;
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(common))
      if (v !== (e as unknown as Record<string, unknown>)[k]) patch[k] = v;
    if (timing.allDay !== e.allDay) patch['allDay'] = timing.allDay;
    if (timing.timezone !== e.timezone) patch['timezone'] = timing.timezone;
    if (timing.rrule !== e.rrule) patch['rrule'] = timing.rrule;
    const timePatch = timeChanged || timing.allDay !== e.allDay || timing.timezone !== e.timezone;
    if (!Object.keys(patch).length && !timePatch) return;

    if (!e.rrule || (this.data.occurrence === undefined && !timePatch && !('rrule' in patch))) {
      // a single event (or a plain change of a series with no occurrence in hand)
      const delta = when.startMs - occStart;
      await this.store.updateEvent(e.id, {
        ...patch,
        ...(timePatch
          ? {
              startAt: new Date(new Date(e.startAt).getTime() + delta).toISOString(),
              endAt: new Date(
                new Date(e.startAt).getTime() + delta + (when.endMs - when.startMs),
              ).toISOString(),
            }
          : {}),
      } as never);
      return;
    }
    const scope = await this.askScope('edit');
    if (!scope) throw new CalendarError('invalid');
    const occurrence = this.data.occurrence!;
    const times = timePatch
      ? { startAt: new Date(when.startMs).toISOString(), endAt: new Date(when.endMs).toISOString() }
      : {};
    if (scope === 'this') {
      const only: Record<string, unknown> = { ...patch, ...times };
      delete only['rrule'];
      delete only['allDay'];
      delete only['timezone'];
      delete only['kind'];
      delete only['visibility'];
      await this.store.updateEvent(e.id, only as never, 'this', occurrence);
    } else if (scope === 'following') {
      await this.store.updateFollowing(e.id, occurrence, { ...patch, ...times } as never);
    } else {
      // the whole series: a change of time applies to every occurrence by the same amount
      const delta = when.startMs - occStart;
      const base = new Date(e.startAt).getTime();
      const whole = timePatch
        ? {
            startAt: new Date(base + delta).toISOString(),
            endAt: new Date(base + delta + (when.endMs - when.startMs)).toISOString(),
          }
        : {};
      await this.store.updateEvent(e.id, { ...patch, ...whole } as never);
    }
  }

  protected async cancelEvent(): Promise<void> {
    const e = this.event();
    if (!e) return;
    try {
      if (e.rrule && this.data.occurrence) {
        const scope = await this.askScope('cancel');
        if (!scope) return;
        if (scope === 'following') await this.store.cancelFollowing(e.id, this.data.occurrence);
        else await this.store.cancelEvent(e.id, scope, this.data.occurrence);
      } else {
        if (
          !(await this.dialogs.confirm({
            titleKey: 'calendar.cancelEvent',
            messageKey: 'calendar.cancelConfirm',
            params: { title: e.title },
            confirmKey: 'calendar.cancelEvent',
            danger: true,
          }))
        )
          return;
        await this.store.cancelEvent(e.id, 'all');
      }
      this.ref.close(true);
    } catch (err) {
      this.error.set(calErr(err));
    }
  }

  protected async duplicate(): Promise<void> {
    const e = this.event();
    if (!e) return;
    try {
      const copy = await this.store.duplicate(e.id);
      this.notify.info('calendar.duplicated', { title: copy.title });
      this.ref.close(true);
    } catch (err) {
      this.error.set(calErr(err));
    }
  }
}
