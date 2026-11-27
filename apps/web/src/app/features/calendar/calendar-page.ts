import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { TranslocoPipe } from '@jsverse/transloco';
import { Permission } from '@os-planner/shared/lite';
import type { EditScope } from '@os-planner/shared';
import { Language } from '../../core/i18n';
import { Notify } from '../../core/notify';
import { AuthStore } from '../../core/auth-store';
import { BoardStore } from '../../data/board-store';
import { CalendarStore } from '../../data/calendar-store';
import { IcsStore } from '../../data/ics-store';
import { TeamStore } from '../../data/team-store';
import {
  addMonths,
  atMinute,
  clock,
  DAY_MS,
  dayFromIso,
  dayOf,
  daysOf,
  deviceZone,
  entriesBetween,
  externalEntries,
  isoDay,
  layoutDay,
  longDay,
  minuteOf,
  monthStart,
  snap,
  spaceColor,
  startOfDay,
  weekdayName,
  weekStart,
  VIEWS,
  type Entry,
  type Placed,
  type View,
} from './cal-util';
import { calErr, EventDialog, ScopeDialog, type EventDialogData } from './event-dialog';
import { ExternalEventDialog } from './external-event-dialog';

/** Pixels per minute in the time grid. */
const PPM = 0.8;
const DRAG_PX = 5;
const VIEW_KEY = 'os_planner.cal.view';
const FILTER_KEY = 'os_planner.cal.filter';

type Drag =
  | {
      mode: 'move';
      entry: Entry;
      x: number;
      y: number;
      moved: boolean;
      days: { day: number; left: number; right: number; top: number }[];
      where: 'grid' | 'month';
    }
  | { mode: 'resize'; entry: Entry; y: number; moved: boolean; colTop: number }
  | { mode: 'create'; day: number; y: number; colTop: number; moved: boolean; fromMin: number };

interface Cell {
  day: number;
  iso: string;
  num: number;
  other: boolean;
  today: boolean;
  entries: Entry[];
}

/**
 * The calendar: month, week, day and agenda over every meeting and event of the person, and the tasks assigned to them that have a
 * date. Everything is read from this device (events and tasks are synced), so it works offline too. Meetings and events can be
 * dragged to another time (and resized, and made by dragging over empty time) where the person may change them; a task can be moved
 * where they may edit it.
 */
@Component({
  selector: 'app-calendar',
  imports: [RouterLink, MatIconModule, TranslocoPipe],
  template: `
    <div class="page" tabindex="-1" (keydown)="onKey($event)" data-calendar>
      <header class="bar">
        <button type="button" class="btn" (click)="today()" data-action="today">
          {{ 'calendar.today' | transloco }}
        </button>
        <button
          type="button"
          class="icon"
          (click)="step(-1)"
          [attr.aria-label]="'calendar.previous' | transloco"
          data-action="prev"
        >
          <mat-icon>chevron_left</mat-icon>
        </button>
        <button
          type="button"
          class="icon"
          (click)="step(1)"
          [attr.aria-label]="'calendar.next' | transloco"
          data-action="next"
        >
          <mat-icon>chevron_right</mat-icon>
        </button>
        <h1 data-range-title>{{ title() }}</h1>
        <span class="grow"></span>
        <div class="views" role="tablist">
          @for (v of views; track v) {
            <button
              type="button"
              role="tab"
              [class.on]="view() === v"
              [attr.aria-selected]="view() === v"
              (click)="setView(v)"
              [attr.data-view-btn]="v"
            >
              {{ 'calendar.view.' + v | transloco }}
            </button>
          }
        </div>
        <button type="button" class="btn primary" (click)="newEvent()" data-action="new-event">
          <mat-icon>add</mat-icon>{{ 'calendar.newEvent' | transloco }}
        </button>
      </header>

      <div class="body">
        <aside class="side" [class.closed]="!sideOpen()">
          <div class="mini" data-mini>
            <div class="mini-head">
              <button
                type="button"
                class="icon sm"
                (click)="miniStep(-1)"
                [attr.aria-label]="'calendar.previous' | transloco"
              >
                <mat-icon>chevron_left</mat-icon>
              </button>
              <span class="grow">{{ miniTitle() }}</span>
              <button
                type="button"
                class="icon sm"
                (click)="miniStep(1)"
                [attr.aria-label]="'calendar.next' | transloco"
              >
                <mat-icon>chevron_right</mat-icon>
              </button>
            </div>
            <div class="mini-grid">
              @for (n of weekdayHeads(); track $index) {
                <span class="mh">{{ n }}</span>
              }
              @for (c of miniDays(); track c.day) {
                <button
                  type="button"
                  class="md"
                  [class.other]="c.other"
                  [class.today]="c.today"
                  [class.sel]="c.sel"
                  (click)="goTo(c.day)"
                  [attr.data-mini-day]="c.iso"
                >
                  {{ c.num }}
                </button>
              }
            </div>
          </div>
          <h2>{{ 'calendar.show' | transloco }}</h2>
          <label class="chk"
            ><input
              type="checkbox"
              [checked]="showMeetings()"
              (change)="toggleFilter('meetings')"
              data-filter="meetings"
            />{{ 'calendar.filter.meetings' | transloco }}</label
          >
          <label class="chk"
            ><input
              type="checkbox"
              [checked]="showEvents()"
              (change)="toggleFilter('events')"
              data-filter="events"
            />{{ 'calendar.filter.events' | transloco }}</label
          >
          <label class="chk"
            ><input
              type="checkbox"
              [checked]="showTasks()"
              (change)="toggleFilter('tasks')"
              data-filter="tasks"
            />{{ 'calendar.filter.tasks' | transloco }}</label
          >
          <h2>{{ 'calendar.calendars' | transloco }}</h2>
          @for (s of spaceList(); track s.id) {
            <label class="chk"
              ><input
                type="checkbox"
                [checked]="!hidden().has(s.id)"
                (change)="toggleSpace(s.id)"
                [attr.data-space-toggle]="s.id"
              /><span class="dot" [style.background]="s.color"></span>{{ s.name }}</label
            >
          }
          @for (c of ics.calendars(); track c.id) {
            @if (c.enabled) {
              <label class="chk"
                ><input
                  type="checkbox"
                  [checked]="!hidden().has(c.id)"
                  (change)="toggleSpace(c.id)"
                  [attr.data-ext-toggle]="c.id"
                /><span class="dot" [style.background]="c.color"></span>{{ c.name
                }}<mat-icon class="ci">lock</mat-icon></label
              >
            }
          }
          @if (spaceFilter()) {
            <a class="link" routerLink="/app/calendar" data-action="all-calendars">{{
              'calendar.allCalendars' | transloco
            }}</a>
          }
          <details class="settings" data-calendar-settings>
            <summary>{{ 'calendar.settings' | transloco }}</summary>
            <label class="fld"
              >{{ 'calendar.weekStart' | transloco }}
              <select
                [value]="store.settings().weekStart"
                (change)="setWeekStart($any($event.target).value)"
                data-setting="week-start"
              >
                @for (d of weekStarts; track d) {
                  <option [value]="d" [selected]="store.settings().weekStart === d">
                    {{ dayName(d) }}
                  </option>
                }
              </select>
            </label>
            <label class="fld"
              >{{ 'calendar.defaultTimezone' | transloco }}
              <input
                type="text"
                list="cal-tz"
                [value]="store.settings().defaultTz ?? ''"
                [placeholder]="deviceTz"
                (change)="setZone($any($event.target).value)"
                data-setting="timezone"
              />
              <datalist id="cal-tz">
                @for (z of zones; track z) {
                  <option [value]="z"></option>
                }
              </datalist>
            </label>
            <div class="fld">
              {{ 'calendar.defaultReminders' | transloco }}
              <div class="rems">
                @for (m of reminderChoices; track m) {
                  <button
                    type="button"
                    class="rem"
                    [class.on]="store.settings().defaultReminders.includes(m)"
                    [attr.aria-pressed]="store.settings().defaultReminders.includes(m)"
                    (click)="toggleDefaultReminder(m)"
                    [attr.data-default-reminder]="m"
                  >
                    {{ remLabel(m) }}
                  </button>
                }
              </div>
            </div>
            <label class="chk"
              ><input
                type="checkbox"
                [checked]="store.settings().openInvites"
                (change)="setOpenInvites($any($event.target).checked)"
                data-setting="open-invites"
              />{{ 'calendar.openInvites' | transloco }}</label
            >
            <label class="chk"
              ><input
                type="checkbox"
                [checked]="store.settings().emailReminders"
                (change)="setEmailReminders($any($event.target).checked)"
                data-setting="email-reminders"
              />{{ 'calendar.emailReminders' | transloco }}</label
            >
          </details>
        </aside>

        <main class="main">
          @if (pending() > 0) {
            <p class="pending" data-pending-invites>
              {{ 'calendar.pendingInvites' | transloco: { n: pending() } }}
            </p>
          }
          @switch (view()) {
            @case ('month') {
              <div class="month" data-view="month">
                <div class="dow">
                  @for (n of weekdayHeads(); track $index) {
                    <span>{{ n }}</span>
                  }
                </div>
                <div class="mgrid">
                  @for (c of cells(); track c.day) {
                    <div
                      class="cell"
                      [class.other]="c.other"
                      [class.today]="c.today"
                      [class.drop]="dropDay() === c.day"
                      [attr.data-day]="c.iso"
                      (click)="newOn(c.day)"
                    >
                      <span class="num">{{ c.num }}</span>
                      @for (e of c.entries.slice(0, 4); track e.key) {
                        <button
                          type="button"
                          class="chip"
                          [class.task]="e.source === 'task'"
                          [class.done]="e.completed"
                          [class.invited]="e.rsvp === 'invited'"
                          [class.declined]="e.rsvp === 'declined'"
                          [class.conflict]="e.conflict"
                          [class.external]="e.source === 'external'"
                          [style.--c]="color(e)"
                          (click)="open(e); $event.stopPropagation()"
                          (pointerdown)="down($event, e, 'month')"
                          [attr.data-event-key]="e.key"
                          [attr.data-source]="e.source"
                          [attr.data-title]="e.title"
                          [attr.title]="e.title"
                        >
                          @if (e.source === 'task') {
                            <mat-icon class="ci">task_alt</mat-icon>
                          } @else if (e.source === 'external') {
                            <mat-icon class="ci">lock</mat-icon>
                          } @else if (!e.allDay) {
                            <span class="ct">{{ time(e.startMs) }}</span>
                          }
                          <span class="cn">{{ e.title }}</span>
                        </button>
                      }
                      @if (c.entries.length > 4) {
                        <button
                          type="button"
                          class="more"
                          (click)="goDay(c.day); $event.stopPropagation()"
                          [attr.data-more]="c.iso"
                        >
                          {{ 'calendar.more' | transloco: { n: c.entries.length - 4 } }}
                        </button>
                      }
                    </div>
                  }
                </div>
              </div>
            }
            @case ('agenda') {
              <div class="agenda" data-view="agenda">
                @for (g of agenda(); track g.day) {
                  <section [attr.data-agenda-day]="g.iso">
                    <h2 [class.today]="g.today">{{ g.label }}</h2>
                    @for (e of g.entries; track e.key) {
                      <button
                        type="button"
                        class="row"
                        [class.invited]="e.rsvp === 'invited'"
                        [class.declined]="e.rsvp === 'declined'"
                        [class.done]="e.completed"
                        [class.external]="e.source === 'external'"
                        (click)="open(e)"
                        [attr.data-event-key]="e.key"
                        [attr.data-source]="e.source"
                        [attr.data-title]="e.title"
                      >
                        <span class="dot" [style.background]="color(e)"></span>
                        <span class="when">{{
                          e.allDay
                            ? ('calendar.allDay' | transloco)
                            : time(e.startMs) + ' – ' + time(e.endMs)
                        }}</span>
                        <span class="t">{{ e.title }}</span>
                        @if (e.source === 'task') {
                          <mat-icon class="ci" [attr.title]="'calendar.task' | transloco"
                            >task_alt</mat-icon
                          >
                        }
                        @if (e.source === 'external') {
                          <mat-icon class="ci" [attr.title]="e.sourceName">lock</mat-icon>
                        }
                        @if (e.conflict) {
                          <mat-icon class="ci warn" [attr.title]="'calendar.conflict' | transloco"
                            >warning</mat-icon
                          >
                        }
                        @if (e.rsvp && e.rsvp !== 'accepted') {
                          <span class="tag">{{ 'rsvp.' + e.rsvp | transloco }}</span>
                        }
                      </button>
                    }
                  </section>
                } @empty {
                  <p class="muted empty" data-agenda-empty>{{ 'calendar.nothing' | transloco }}</p>
                }
              </div>
            }
            @default {
              <div class="tg" [attr.data-view]="view()" [style.--cols]="columns().length">
                <div class="tg-head">
                  <span class="gutter"></span>
                  @for (c of columns(); track c.day) {
                    <button
                      type="button"
                      class="dh"
                      [class.today]="c.today"
                      (click)="goDay(c.day)"
                      [attr.data-day-head]="c.iso"
                    >
                      <span class="dn">{{ c.dow }}</span><span class="dd">{{ c.num }}</span>
                    </button>
                  }
                </div>
                <div class="tg-allday" data-allday>
                  <span class="gutter">{{ 'calendar.allDayShort' | transloco }}</span>
                  @for (c of columns(); track c.day) {
                    <div class="adc" [attr.data-allday-day]="c.iso">
                      @for (e of c.allDay; track e.key) {
                        <button
                          type="button"
                          class="chip"
                          [class.task]="e.source === 'task'"
                          [class.done]="e.completed"
                          [class.invited]="e.rsvp === 'invited'"
                          [class.external]="e.source === 'external'"
                          [style.--c]="color(e)"
                          (click)="open(e)"
                          [attr.data-event-key]="e.key"
                          [attr.data-source]="e.source"
                          [attr.data-title]="e.title"
                          [attr.title]="e.title"
                        >
                          <span class="cn">{{ e.title }}</span>
                        </button>
                      }
                    </div>
                  }
                </div>
                <div class="tg-scroll" #scroller data-grid>
                  <div class="tg-body" [style.height.px]="24 * 60 * ppm">
                    <div class="hours">
                      @for (h of hours; track h) {
                        <span class="hl" [style.top.px]="h * 60 * ppm">{{
                          h ? pad(h) + ':00' : ''
                        }}</span>
                      }
                    </div>
                    @for (c of columns(); track c.day) {
                      <div
                        class="col"
                        [class.today]="c.today"
                        [attr.data-col]="c.iso"
                        (pointerdown)="downEmpty($event, c.day)"
                      >
                        @for (h of hours; track h) {
                          <div class="line" [style.top.px]="h * 60 * ppm"></div>
                        }
                        @if (c.today) {
                          <div class="now" [style.top.px]="nowMin() * ppm" data-now></div>
                        }
                        @for (p of c.placed; track p.entry.key) {
                          <div
                            class="ev"
                            [class.task]="p.entry.source === 'task'"
                            [class.external]="p.entry.source === 'external'"
                            [class.done]="p.entry.completed"
                            [class.invited]="p.entry.rsvp === 'invited'"
                            [class.declined]="p.entry.rsvp === 'declined'"
                            [class.conflict]="p.entry.conflict"
                            [class.dragging]="preview()?.key === p.entry.key"
                            [style.top.px]="p.top * ppm"
                            [style.height.px]="p.height * ppm"
                            [style.left.%]="(p.col / p.cols) * 100"
                            [style.width.%]="100 / p.cols"
                            [style.--c]="color(p.entry)"
                            (pointerdown)="down($event, p.entry, 'grid')"
                            (click)="onEventClick($event, p.entry)"
                            (keydown.enter)="open(p.entry)"
                            tabindex="0"
                            role="button"
                            [attr.data-event-key]="p.entry.key"
                            [attr.data-source]="p.entry.source"
                            [attr.data-title]="p.entry.title"
                            [attr.data-start]="iso(p.entry.startMs)"
                          >
                            @if (p.entry.source === 'external') {
                              <mat-icon class="lk">lock</mat-icon>
                            }
                            <span class="et">{{ p.entry.title }}</span>
                            <span class="etime"
                              >{{ time(p.entry.startMs) }} – {{ time(p.entry.endMs) }}</span
                            >
                            @if (p.entry.source === 'event' && canResize(p.entry)) {
                              <span
                                class="rs"
                                (pointerdown)="downResize($event, p.entry)"
                                data-resize
                              ></span>
                            }
                          </div>
                        }
                        @if (createPreview(); as cp) {
                          @if (cp.day === c.day) {
                            <div
                              class="ev ghost"
                              [style.top.px]="cp.fromMin * ppm"
                              [style.height.px]="(cp.toMin - cp.fromMin) * ppm"
                            ></div>
                          }
                        }
                      </div>
                    }
                  </div>
                </div>
              </div>
            }
          }
        </main>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
      height: 100%;
    }
    .page {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      outline: none;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    h1 {
      margin: 0 8px;
      font-size: 20px;
      font-weight: 600;
    }
    .grow {
      flex: 1;
    }
    .btn,
    .views button {
      font: inherit;
      color: var(--text);
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 5px 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .btn.primary {
      background: var(--mat-sys-primary);
      color: var(--mat-sys-on-primary);
      border-color: transparent;
    }
    .views {
      display: inline-flex;
    }
    .views button {
      border-radius: 0;
      margin-left: -1px;
    }
    .views button:first-child {
      border-radius: 8px 0 0 8px;
      margin-left: 0;
    }
    .views button:last-child {
      border-radius: 0 8px 8px 0;
    }
    .views button.on {
      background: var(--surface-3);
      border-color: var(--mat-sys-primary);
      position: relative;
    }
    .icon {
      background: none;
      border: 0;
      color: var(--text);
      cursor: pointer;
      border-radius: 50%;
      width: 32px;
      height: 32px;
      display: grid;
      place-items: center;
    }
    .icon:hover {
      background: var(--surface-3);
    }
    .icon.sm {
      width: 26px;
      height: 26px;
    }
    .body {
      display: flex;
      flex: 1;
      min-height: 0;
    }
    .side {
      width: 236px;
      flex: none;
      padding: 12px;
      border-right: 1px solid var(--border);
      overflow: auto;
    }
    .side h2 {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      margin: 16px 0 6px;
    }
    .chk {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 2px 0;
      font-size: 14px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex: none;
      display: inline-block;
    }
    .link {
      font-size: 13px;
    }
    .settings {
      margin-top: 18px;
      font-size: 13px;
    }
    .settings summary {
      cursor: pointer;
      color: var(--text-dim);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 12px;
    }
    .fld {
      display: grid;
      gap: 4px;
      margin: 8px 0;
    }
    .fld select,
    .fld input {
      font: inherit;
      color: inherit;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 4px 6px;
    }
    .rems {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }
    .rem {
      font: inherit;
      font-size: 12px;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      border-radius: 12px;
      padding: 1px 8px;
      cursor: pointer;
    }
    .rem.on {
      background: var(--mat-sys-primary);
      color: var(--mat-sys-on-primary);
      border-color: transparent;
    }
    .mini-head {
      display: flex;
      align-items: center;
      font-size: 13px;
      font-weight: 600;
    }
    .mini-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 1px;
      text-align: center;
      font-size: 12px;
      margin-top: 4px;
    }
    .mh {
      color: var(--text-dim);
      padding: 2px 0;
    }
    .md {
      font: inherit;
      font-size: 12px;
      background: none;
      border: 0;
      color: var(--text);
      border-radius: 50%;
      aspect-ratio: 1;
      cursor: pointer;
    }
    .md:hover {
      background: var(--surface-3);
    }
    .md.other {
      color: color-mix(in srgb, var(--text-dim) 55%, var(--text));
    }
    .md.today {
      outline: 1px solid var(--mat-sys-primary);
    }
    .md.sel {
      background: var(--mat-sys-primary);
      color: var(--mat-sys-on-primary);
    }
    .main {
      flex: 1;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: auto;
    }
    .pending {
      margin: 8px 16px 0;
      padding: 6px 12px;
      border-radius: 8px;
      background: color-mix(in srgb, var(--mat-sys-primary) 15%, var(--surface));
      font-size: 14px;
    }
    .muted {
      color: var(--text-dim);
    }
    .empty {
      text-align: center;
      padding: 48px 0;
    }

    .month {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 480px;
    }
    .dow {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      text-align: center;
      font-size: 12px;
      color: var(--text-dim);
      padding: 6px 0;
    }
    .mgrid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      grid-auto-rows: minmax(92px, 1fr);
      flex: 1;
      border-top: 1px solid var(--border);
      border-left: 1px solid var(--border);
    }
    .cell {
      border-right: 1px solid var(--border);
      border-bottom: 1px solid var(--border);
      padding: 2px 3px;
      min-width: 0;
      overflow: hidden;
      cursor: default;
    }
    .cell.other {
      background: color-mix(in srgb, var(--surface-3) 40%, transparent);
    }
    .cell.drop {
      outline: 2px solid var(--mat-sys-primary);
      outline-offset: -2px;
    }
    .num {
      font-size: 12px;
      display: inline-block;
      width: 22px;
      height: 22px;
      line-height: 22px;
      text-align: center;
      border-radius: 50%;
    }
    .cell.today .num {
      background: var(--mat-sys-primary);
      color: var(--mat-sys-on-primary);
    }
    .chip {
      display: flex;
      align-items: center;
      gap: 4px;
      width: 100%;
      box-sizing: border-box;
      font: inherit;
      font-size: 12px;
      text-align: left;
      color: var(--text);
      background: color-mix(in srgb, var(--c) 22%, var(--surface));
      border: 0;
      border-left: 3px solid var(--c);
      border-radius: 4px;
      padding: 1px 4px;
      margin: 1px 0;
      cursor: pointer;
      overflow: hidden;
      touch-action: none;
    }
    .chip .cn {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .chip .ct {
      color: var(--text-dim);
      flex: none;
    }
    .chip.task {
      border-left-style: dashed;
    }
    .chip.external,
    .ev.external,
    .row.external {
      font-style: italic;
      opacity: 0.8;
    }
    .chip.external {
      background: color-mix(in srgb, var(--c) 10%, var(--surface));
      border-left-style: dotted;
    }
    .ev.external {
      background: color-mix(in srgb, var(--c) 10%, var(--surface));
      border-style: dotted;
      border-left-width: 4px;
    }
    .ev .lk {
      position: absolute;
      top: 2px;
      right: 2px;
      width: 12px;
      height: 12px;
      font-size: 12px;
      opacity: 0.7;
    }
    .chip.invited,
    .ev.invited {
      border-style: dashed;
      font-weight: 600;
    }
    .chip.declined,
    .ev.declined {
      opacity: 0.55;
      text-decoration: line-through;
    }
    .done .cn,
    .done .et {
      text-decoration: line-through;
      opacity: 0.7;
    }
    .ci {
      font-size: 14px;
      width: 14px;
      height: 14px;
      flex: none;
    }
    .ci.warn {
      color: #d97706;
    }
    .more {
      font: inherit;
      font-size: 11px;
      background: none;
      border: 0;
      color: var(--text-dim);
      cursor: pointer;
      padding: 0 4px;
    }

    .tg {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
    .tg-head,
    .tg-allday {
      display: grid;
      grid-template-columns: 52px repeat(var(--cols), 1fr);
      border-bottom: 1px solid var(--border);
    }
    .gutter {
      font-size: 11px;
      color: var(--text-dim);
      text-align: right;
      padding: 4px 6px 0 0;
    }
    .dh {
      font: inherit;
      background: none;
      border: 0;
      color: var(--text);
      padding: 6px 0;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .dn {
      font-size: 12px;
      color: var(--text-dim);
      text-transform: uppercase;
    }
    .dd {
      font-size: 20px;
      width: 34px;
      height: 34px;
      line-height: 34px;
      border-radius: 50%;
    }
    .dh.today .dd {
      background: var(--mat-sys-primary);
      color: var(--mat-sys-on-primary);
    }
    .adc {
      padding: 2px;
      min-height: 26px;
      border-left: 1px solid var(--border);
      min-width: 0;
    }
    .tg-scroll {
      flex: 1;
      overflow: auto;
      min-height: 240px;
    }
    .tg-body {
      display: grid;
      grid-template-columns: 52px repeat(var(--cols), 1fr);
      position: relative;
    }
    .hours {
      position: relative;
    }
    .hl {
      position: absolute;
      right: 6px;
      font-size: 11px;
      color: var(--text-dim);
      transform: translateY(-50%);
    }
    .col {
      position: relative;
      border-left: 1px solid var(--border);
      touch-action: none;
      user-select: none;
    }
    .line {
      position: absolute;
      left: 0;
      right: 0;
      border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
      pointer-events: none;
    }
    .now {
      position: absolute;
      left: 0;
      right: 0;
      border-top: 2px solid #ef4444;
      z-index: 3;
      pointer-events: none;
    }
    .ev {
      position: absolute;
      box-sizing: border-box;
      padding: 2px 4px;
      overflow: hidden;
      font-size: 12px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--c) 24%, var(--surface));
      border: 1px solid var(--c);
      border-left-width: 4px;
      cursor: pointer;
      z-index: 2;
      touch-action: none;
      display: flex;
      flex-direction: column;
    }
    .ev.task {
      border-style: dashed;
    }
    .ev.ghost {
      background: color-mix(in srgb, var(--mat-sys-primary) 25%, transparent);
      border: 1px dashed var(--mat-sys-primary);
      left: 0;
      width: 100%;
      pointer-events: none;
    }
    .ev.dragging {
      opacity: 0.8;
      box-shadow: 0 4px 14px rgb(0 0 0 / 25%);
      z-index: 4;
    }
    .ev.conflict {
      box-shadow: inset 0 0 0 1px #d97706;
    }
    .et {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .etime {
      color: var(--text-dim);
      font-size: 11px;
    }
    .rs {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 6px;
      cursor: ns-resize;
    }

    .agenda {
      padding: 8px 16px 32px;
      max-width: 860px;
      width: 100%;
      box-sizing: border-box;
      margin: 0 auto;
    }
    .agenda h2 {
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      margin: 18px 0 4px;
    }
    .agenda h2.today {
      color: var(--mat-sys-primary);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      font: inherit;
      color: var(--text);
      background: none;
      border: 0;
      border-radius: 8px;
      padding: 7px 10px;
      cursor: pointer;
      text-align: left;
    }
    .row:hover {
      background: var(--surface-3);
    }
    .row .when {
      width: 110px;
      flex: none;
      font-size: 13px;
      color: var(--text-dim);
    }
    .row .t {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .row.declined .t {
      text-decoration: line-through;
      opacity: 0.6;
    }
    .row.invited .t {
      font-weight: 600;
    }
    .tag {
      font-size: 11px;
      padding: 1px 8px;
      border-radius: 8px;
      background: var(--surface-3);
    }
    @media (max-width: 860px) {
      .side {
        display: none;
      }
      .gutter {
        font-size: 10px;
      }
    }
  `,
})
export class CalendarPage {
  protected readonly store = inject(CalendarStore);
  protected readonly ics = inject(IcsStore);
  private readonly boards = inject(BoardStore);
  private readonly teams = inject(TeamStore);
  private readonly auth = inject(AuthStore);
  private readonly lang = inject(Language);
  private readonly notify = inject(Notify);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly views = VIEWS;
  protected readonly weekStarts = [1, 0, 6];
  protected readonly reminderChoices = [0, 5, 10, 15, 30, 60, 120, 1440];
  protected readonly deviceTz = deviceZone();
  protected readonly zones: readonly string[] = (() => {
    try {
      return (
        (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.(
          'timeZone',
        ) ?? []
      );
    } catch {
      return [];
    }
  })();
  protected readonly ppm = PPM;
  protected readonly hours = Array.from({ length: 24 }, (_, i) => i);
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');

  private readonly params = toSignal(this.route.queryParamMap, { requireSync: false });
  private readonly now = signal(Date.now());

  protected readonly tz = computed(() => this.store.settings().defaultTz ?? deviceZone());
  private readonly wkst = computed(() => this.store.settings().weekStart);
  protected readonly view = signal<View>(readView());
  protected readonly anchor = signal<number>(dayOf(Date.now(), deviceZone()));
  protected readonly sideOpen = signal(true);
  protected readonly spaceFilter = computed(() => this.params()?.get('space') ?? '');
  private readonly filters = signal(readFilters());
  protected readonly showMeetings = computed(() => this.filters().meetings);
  protected readonly showEvents = computed(() => this.filters().events);
  protected readonly showTasks = computed(() => this.filters().tasks);
  protected readonly hidden = computed(() => new Set(this.store.settings().hiddenSpaces));
  protected readonly pending = this.store.pendingInvites;

  /** What a drag is showing right now (the entry drawn at its new time). */
  protected readonly preview = signal<{ key: string; startMs: number; endMs: number } | null>(null);
  protected readonly createPreview = signal<{ day: number; fromMin: number; toMin: number } | null>(
    null,
  );
  protected readonly dropDay = signal<number | null>(null);
  private drag: Drag | null = null;
  private suppressClick = false;

  // ---------------------------------------------------------------- what is shown

  private readonly range = computed(() => {
    const a = this.anchor();
    switch (this.view()) {
      case 'month': {
        const first = weekStart(monthStart(a), this.wkst());
        return { first, count: 42 };
      }
      case 'week':
        return { first: weekStart(a, this.wkst()), count: 7 };
      case 'day':
        return { first: a, count: 1 };
      default:
        return { first: a, count: 60 };
    }
  });

  private readonly allEntries = computed(() => {
    const { first, count } = this.range();
    const tz = this.tz();
    const f = this.filters();
    const from = startOfDay(first, tz) - DAY_MS;
    const to = startOfDay(first + count, tz) + DAY_MS;
    const out = entriesBetween(
      this.store.liveEvents(),
      this.boards.tasks(),
      this.auth.userId() ?? '',
      from,
      to,
      { meetings: f.meetings, events: f.events, tasks: f.tasks },
    );
    // The calendars the person follows (read only); a space filter is about spaces, so it leaves them out.
    if (!this.spaceFilter())
      for (const x of externalEntries(this.ics.items())) if (x.startMs < to && x.endMs > from) out.push(x);
    const hidden = this.hidden();
    const only = this.spaceFilter();
    const p = this.preview();
    return out
      .filter((e) => !hidden.has(e.spaceId) && (!only || e.spaceId === only))
      .map((e) => (p && p.key === e.key ? { ...e, startMs: p.startMs, endMs: p.endMs } : e));
  });

  /** Entries by the day they cover (inside the range). */
  private readonly byDay = computed(() => {
    const { first, count } = this.range();
    const tz = this.tz();
    const map = new Map<number, Entry[]>();
    for (const e of this.allEntries())
      for (const d of daysOf(e, tz)) {
        if (d < first || d >= first + count) continue;
        (map.get(d) ?? map.set(d, []).get(d)!).push(e);
      }
    for (const list of map.values())
      list.sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.startMs - b.startMs);
    return map;
  });

  protected readonly today$ = computed(() => dayOf(this.now(), this.tz()));
  protected readonly nowMin = computed(() => minuteOf(this.now(), this.tz()));

  protected readonly cells = computed<Cell[]>(() => {
    const { first, count } = this.range();
    const month = this.anchor();
    const today = this.today$();
    const refMonth = new Date(month * DAY_MS).getUTCMonth();
    return Array.from({ length: count }, (_, i) => {
      const day = first + i;
      const d = new Date(day * DAY_MS);
      return {
        day,
        iso: isoDay(day),
        num: d.getUTCDate(),
        other: d.getUTCMonth() !== refMonth,
        today: day === today,
        entries: this.byDay().get(day) ?? [],
      };
    });
  });

  protected readonly columns = computed(() => {
    const { first, count } = this.range();
    const today = this.today$();
    const tz = this.tz();
    return Array.from({ length: count }, (_, i) => {
      const day = first + i;
      const entries = this.byDay().get(day) ?? [];
      const allDay = entries.filter((e) => e.allDay);
      const timed = entries.filter((e) => !e.allDay);
      return {
        day,
        iso: isoDay(day),
        num: new Date(day * DAY_MS).getUTCDate(),
        dow: weekdayName(new Date(day * DAY_MS).getUTCDay(), this.lang.current),
        today: day === today,
        allDay,
        placed: layoutDay(timed, day, tz) as Placed[],
      };
    });
  });

  protected readonly agenda = computed(() => {
    const today = this.today$();
    const out: { day: number; iso: string; today: boolean; label: string; entries: Entry[] }[] = [];
    for (const [day, entries] of [...this.byDay()].sort((a, b) => a[0] - b[0]))
      out.push({
        day,
        iso: isoDay(day),
        today: day === today,
        label: longDay(day, this.lang.current),
        entries,
      });
    return out;
  });

  protected readonly title = computed(() => {
    const a = this.anchor();
    const l = this.lang.current;
    switch (this.view()) {
      case 'month':
      case 'agenda':
        return longDay(a, l, { month: 'long', year: 'numeric' });
      case 'week': {
        const { first } = this.range();
        const s = longDay(first, l, { day: 'numeric', month: 'short' });
        return `${s} – ${longDay(first + 6, l, { day: 'numeric', month: 'short', year: 'numeric' })}`;
      }
      default:
        return longDay(a, l);
    }
  });

  protected readonly weekdayHeads = computed(() =>
    Array.from({ length: 7 }, (_, i) => weekdayName((this.wkst() + i) % 7, this.lang.current)),
  );

  private readonly miniAnchor = signal<number | null>(null);
  protected readonly miniTitle = computed(() =>
    longDay(this.miniAnchor() ?? this.anchor(), this.lang.current, {
      month: 'long',
      year: 'numeric',
    }),
  );
  protected readonly miniDays = computed(() => {
    const base = this.miniAnchor() ?? this.anchor();
    const first = weekStart(monthStart(base), this.wkst());
    const month = new Date(base * DAY_MS).getUTCMonth();
    const today = this.today$();
    return Array.from({ length: 42 }, (_, i) => {
      const day = first + i;
      const d = new Date(day * DAY_MS);
      return {
        day,
        iso: isoDay(day),
        num: d.getUTCDate(),
        other: d.getUTCMonth() !== month,
        today: day === today,
        sel: day === this.anchor(),
      };
    });
  });

  protected readonly spaceList = computed(() => {
    const out: { id: string; name: string; color: string }[] = [];
    const personal = this.store.personalSpaceId();
    if (personal)
      out.push({
        id: personal,
        name: this.lang.t('calendar.personal'),
        color: spaceColor(personal, true),
      });
    for (const t of this.teams.teams() ?? [])
      if (this.store.spaceIds().includes(t.spaceId))
        out.push({ id: t.spaceId, name: t.name, color: spaceColor(t.spaceId) });
    for (const p of this.teams.projects())
      if (this.store.spaceIds().includes(p.spaceId))
        out.push({
          id: p.spaceId,
          name: `${this.teams.teamById().get(p.teamId)?.name ?? ''} / ${p.name}`,
          color: spaceColor(p.spaceId),
        });
    return out;
  });

  constructor() {
    void this.ics.loadCalendars().catch(() => undefined);
    // What the followed calendars hold for the days on screen (read from the server; it stays as it was when that fails).
    effect(() => {
      const { first, count } = this.range();
      const tz = this.tz();
      const from = new Date(startOfDay(first, tz) - DAY_MS).toISOString();
      const to = new Date(startOfDay(first + count, tz) + DAY_MS).toISOString();
      untracked(() => void this.ics.loadWindow(from, to));
    });
    const timer = setInterval(() => this.now.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      this.stopDrag();
    });

    // The address says where we are (a notification or a team's calendar tab opens it): view, day, the event to open.
    effect(() => {
      const p = this.params();
      if (!p) return;
      untracked(() => {
        const v = p.get('view');
        if (v && (VIEWS as readonly string[]).includes(v) && v !== this.view())
          this.view.set(v as View);
        const d = p.get('d') ? dayFromIso(p.get('d')!) : null;
        if (d !== null && d !== this.anchor()) this.anchor.set(d);
      });
    });
    effect(() => {
      const id = this.params()?.get('event');
      const e = id ? this.store.eventById().get(id) : undefined;
      if (!id || !e || e.deletedAt) return;
      untracked(() => {
        const next = nextOccurrence(e, this.now());
        this.openEvent(id, next?.originalStart, next?.startMs, next?.endMs);
        void this.router.navigate([], {
          relativeTo: this.route,
          queryParams: { event: null },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        });
      });
    });
    // Scroll the time grid to the morning when it appears.
    effect(() => {
      const el = this.scroller()?.nativeElement;
      if (el) untracked(() => (el.scrollTop = Math.max(0, 7 * 60 * PPM)));
    });
  }

  // ---------------------------------------------------------------- navigating

  protected pad(n: number): string {
    return String(n).padStart(2, '0');
  }
  protected iso(ms: number): string {
    return new Date(ms).toISOString();
  }
  protected time(ms: number): string {
    return clock(ms, this.tz(), this.lang.current);
  }
  protected color(e: Entry): string {
    if (e.source === 'external') return e.color ?? '#6b7280';
    return spaceColor(e.spaceId, this.store.isPersonalSpace(e.spaceId));
  }

  private move(patch: { view?: View; day?: number }): void {
    if (patch.view) {
      this.view.set(patch.view);
      try {
        localStorage.setItem(VIEW_KEY, patch.view);
      } catch {
        /* storage unavailable */
      }
    }
    if (patch.day !== undefined) this.anchor.set(patch.day);
    this.miniAnchor.set(null);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view: this.view(), d: isoDay(this.anchor()) },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  protected setView(v: View): void {
    this.move({ view: v });
  }
  protected today(): void {
    this.move({ day: dayOf(Date.now(), this.tz()) });
  }
  protected goTo(day: number): void {
    this.move({ day });
  }
  protected goDay(day: number): void {
    this.move({ view: 'day', day });
  }
  protected step(n: number): void {
    const a = this.anchor();
    switch (this.view()) {
      case 'month':
        return this.move({ day: addMonths(a, n) });
      case 'week':
        return this.move({ day: a + 7 * n });
      case 'agenda':
        return this.move({ day: a + 30 * n });
      default:
        return this.move({ day: a + n });
    }
  }
  protected miniStep(n: number): void {
    this.miniAnchor.set(addMonths(this.miniAnchor() ?? this.anchor(), n));
  }

  protected onKey(ev: KeyboardEvent): void {
    const t = ev.target as HTMLElement;
    if (
      t.closest('input, select, textarea, [contenteditable]') ||
      ev.ctrlKey ||
      ev.metaKey ||
      ev.altKey
    )
      return;
    const k = ev.key.toLowerCase();
    const views: Record<string, View> = { m: 'month', w: 'week', d: 'day', a: 'agenda' };
    if (k === 't') this.today();
    else if (k === 'arrowleft' || k === 'k') this.step(-1);
    else if (k === 'arrowright' || k === 'j') this.step(1);
    else if (k === 'n') this.newEvent();
    else if (views[k]) this.setView(views[k]!);
    else return;
    ev.preventDefault();
  }

  protected toggleFilter(which: 'meetings' | 'events' | 'tasks'): void {
    this.filters.update((f) => ({ ...f, [which]: !f[which] }));
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(this.filters()));
    } catch {
      /* storage unavailable */
    }
  }
  protected dayName(d: number): string {
    return weekdayName(d, this.lang.current, 'long');
  }
  protected remLabel(m: number): string {
    return m === 0
      ? this.lang.t('reminder.atStart')
      : m >= 1440
        ? this.lang.t('reminder.days', { n: m / 1440 })
        : m >= 60
          ? this.lang.t('reminder.hours', { n: m / 60 })
          : this.lang.t('reminder.minutes', { n: m });
  }
  protected setWeekStart(v: string): void {
    void this.store.saveSettings({ weekStart: Number(v) as 0 | 1 | 6 });
  }
  protected setZone(v: string): void {
    const zone = v.trim();
    if (zone && !this.zones.includes(zone)) return;
    void this.store.saveSettings({ defaultTz: zone || null });
  }
  protected toggleDefaultReminder(m: number): void {
    const now = this.store.settings().defaultReminders;
    void this.store.saveSettings({
      defaultReminders: (now.includes(m) ? now.filter((x) => x !== m) : [...now, m])
        .sort((a, b) => a - b)
        .slice(0, 5),
    });
  }
  protected setOpenInvites(on: boolean): void {
    void this.store.saveSettings({ openInvites: on });
  }
  protected setEmailReminders(on: boolean): void {
    void this.store.saveSettings({ emailReminders: on });
  }

  protected toggleSpace(id: string): void {
    const hidden = new Set(this.store.settings().hiddenSpaces);
    if (!hidden.delete(id)) hidden.add(id);
    void this.store.saveSettings({ hiddenSpaces: [...hidden] });
  }

  // ---------------------------------------------------------------- opening and making

  protected open(e: Entry): void {
    if (this.suppressClick) return;
    if (e.source === 'external') {
      this.dialog.open(ExternalEventDialog, {
        data: { entry: e, tz: this.tz() },
        width: '460px',
        maxWidth: '96vw',
        autoFocus: false,
      });
      return;
    }
    if (e.source === 'task') {
      void this.router.navigate(['/app/b', e.boardId], { queryParams: { task: e.id } });
      return;
    }
    this.openEvent(e.id, e.originalStart, e.startMs, e.endMs);
  }

  protected onEventClick(ev: Event, e: Entry): void {
    ev.stopPropagation();
    this.open(e);
  }

  private openEvent(id: string, occurrence?: string, startMs?: number, endMs?: number): void {
    const data: EventDialogData = { eventId: id, occurrence, startMs, endMs, tz: this.tz() };
    this.dialog.open(EventDialog, { data, width: '640px', maxWidth: '96vw', autoFocus: false });
  }

  protected newEvent(): void {
    const day = this.anchor();
    const base = atMinute(day, 9 * 60, this.tz());
    this.openNew({ startMs: base, endMs: base + 3_600_000, allDay: false });
  }

  protected newOn(day: number): void {
    if (this.suppressClick) return;
    const base = atMinute(day, 9 * 60, this.tz());
    this.openNew({ startMs: base, endMs: base + 3_600_000, allDay: false });
  }

  private openNew(seed: { startMs: number; endMs: number; allDay: boolean }): void {
    const data: EventDialogData = {
      seed: { ...seed, spaceId: this.spaceFilter() || undefined },
      tz: this.tz(),
    };
    this.dialog.open(EventDialog, { data, width: '640px', maxWidth: '96vw', autoFocus: false });
  }

  // ---------------------------------------------------------------- dragging

  /** May the person move this entry: an event they may change, a task they may edit. */
  private canMove(e: Entry): boolean {
    if (e.source === 'task')
      return !!e.boardId && this.boards.can(e.boardId, Permission.EDIT_TASKS);
    const ev = this.store.eventById().get(e.id);
    return !!ev && this.store.canEdit(ev);
  }
  protected canResize(e: Entry): boolean {
    return e.source === 'event' && !e.allDay && this.canMove(e);
  }

  protected down(ev: PointerEvent, e: Entry, where: 'grid' | 'month'): void {
    if (ev.button !== 0 || !this.canMove(e)) return;
    const days =
      where === 'month'
        ? [...document.querySelectorAll<HTMLElement>('[data-day]')].map((el) => ({
            day: dayFromIso(el.dataset['day']!)!,
            ...rectOf(el),
          }))
        : [...document.querySelectorAll<HTMLElement>('[data-col]')].map((el) => ({
            day: dayFromIso(el.dataset['col']!)!,
            ...rectOf(el),
          }));
    this.drag = { mode: 'move', entry: e, x: ev.clientX, y: ev.clientY, moved: false, days, where };
    this.listen();
  }

  protected downResize(ev: PointerEvent, e: Entry): void {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const col = (ev.target as HTMLElement).closest<HTMLElement>('[data-col]')!;
    this.drag = {
      mode: 'resize',
      entry: e,
      y: ev.clientY,
      moved: false,
      colTop: col.getBoundingClientRect().top,
    };
    this.listen();
  }

  protected downEmpty(ev: PointerEvent, day: number): void {
    if (ev.button !== 0 || (ev.target as HTMLElement).closest('.ev')) return;
    const col = ev.currentTarget as HTMLElement;
    const colTop = col.getBoundingClientRect().top;
    const from = clampMin(snap((ev.clientY - colTop) / PPM - 7));
    this.drag = { mode: 'create', day, y: ev.clientY, colTop, moved: false, fromMin: from };
    this.createPreview.set({ day, fromMin: from, toMin: from + 60 });
    this.listen();
  }

  private listen(): void {
    document.addEventListener('pointermove', this.onMove);
    document.addEventListener('pointerup', this.onUp);
    document.addEventListener('pointercancel', this.onCancel);
  }
  private stopDrag(): void {
    document.removeEventListener('pointermove', this.onMove);
    document.removeEventListener('pointerup', this.onUp);
    document.removeEventListener('pointercancel', this.onCancel);
    this.drag = null;
    this.preview.set(null);
    this.createPreview.set(null);
    this.dropDay.set(null);
  }

  private readonly onCancel = (): void => this.stopDrag();

  private readonly onMove = (ev: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    const tz = this.tz();
    if (d.mode === 'create') {
      if (!d.moved && Math.abs(ev.clientY - d.y) < DRAG_PX) return;
      d.moved = true;
      const to = clampMin(snap((ev.clientY - d.colTop) / PPM));
      const a = Math.min(d.fromMin, to);
      const b = Math.max(d.fromMin, to);
      this.createPreview.set({ day: d.day, fromMin: a, toMin: Math.max(b, a + 15) });
      return;
    }
    if (
      !d.moved &&
      Math.hypot(ev.clientX - ('x' in d ? d.x : ev.clientX), ev.clientY - d.y) < DRAG_PX
    )
      return;
    d.moved = true;
    const e = d.entry;
    if (d.mode === 'resize') {
      const end = atMinute(
        dayOf(e.startMs, tz),
        clampMin(snap((ev.clientY - d.colTop) / PPM), 24 * 60),
        tz,
      );
      this.preview.set({
        key: e.key,
        startMs: e.startMs,
        endMs: Math.max(end, e.startMs + 15 * 60_000),
      });
      return;
    }
    const target =
      d.days.find(
        (c) =>
          ev.clientX >= c.left &&
          ev.clientX < c.right &&
          (d.where === 'month' ? ev.clientY >= c.top : true),
      ) ??
      d.days.reduce((best, c) =>
        Math.abs(ev.clientX - (c.left + c.right) / 2) <
        Math.abs(ev.clientX - (best.left + best.right) / 2)
          ? c
          : best,
      );
    const fromDay = e.allDay ? dayOf(e.startMs, 'UTC') : dayOf(e.startMs, tz);
    let dayDelta = target.day - fromDay;
    if (d.where === 'month') {
      const cell = document
        .elementFromPoint(ev.clientX, ev.clientY)
        ?.closest<HTMLElement>('[data-day]');
      const over = cell ? dayFromIso(cell.dataset['day']!) : null;
      if (over !== null) dayDelta = over - fromDay;
      this.dropDay.set(over);
    }
    let startMs: number;
    if (d.where === 'month' || e.allDay) {
      startMs = e.allDay
        ? e.startMs + dayDelta * DAY_MS
        : atMinute(fromDay + dayDelta, minuteOf(e.startMs, tz), tz);
    } else {
      const minutes = clampMin(
        snap(minuteOf(e.startMs, tz) + (ev.clientY - d.y) / PPM),
        24 * 60 - 15,
      );
      startMs = atMinute(fromDay + dayDelta, minutes, tz);
    }
    this.preview.set({ key: e.key, startMs, endMs: startMs + (e.endMs - e.startMs) });
  };

  private readonly onUp = (): void => {
    const d = this.drag;
    const p = this.preview();
    const cp = this.createPreview();
    this.stopDrag();
    if (!d) return;
    if (d.mode === 'create') {
      if (!cp) return;
      this.suppressNextClick();
      const tz = this.tz();
      const click = !d.moved;
      this.openNew({
        startMs: atMinute(cp.day, cp.fromMin, tz),
        endMs: atMinute(cp.day, click ? Math.min(cp.fromMin + 60, 24 * 60 - 1) : cp.toMin, tz),
        allDay: false,
      });
      return;
    }
    if (!d.moved) return;
    this.suppressNextClick();
    if (p && (p.startMs !== d.entry.startMs || p.endMs !== d.entry.endMs))
      void this.commit(d.entry, p.startMs, p.endMs);
  };

  /** A drag ends with a click on the same element: it must not open the entry. */
  private suppressNextClick(): void {
    this.suppressClick = true;
    setTimeout(() => (this.suppressClick = false), 0);
  }

  private async commit(e: Entry, startMs: number, endMs: number): Promise<void> {
    try {
      if (e.source === 'task') return await this.commitTask(e, startMs);
      const ev = this.store.eventById().get(e.id);
      if (!ev) return;
      const delta = startMs - e.startMs;
      const times = {
        startAt: new Date(startMs).toISOString(),
        endAt: new Date(endMs).toISOString(),
      };
      if (!ev.rrule) return await this.store.updateEvent(ev.id, times);
      const scope = await this.askScope();
      if (!scope) return;
      if (scope === 'this') await this.store.updateEvent(ev.id, times, 'this', e.originalStart);
      else if (scope === 'following')
        await this.store.updateFollowing(ev.id, e.originalStart!, times);
      else {
        const base = new Date(ev.startAt).getTime() + delta;
        await this.store.updateEvent(ev.id, {
          startAt: new Date(base).toISOString(),
          endAt: new Date(base + (endMs - startMs)).toISOString(),
        });
      }
    } catch (err) {
      this.notify.error(calErr(err));
    }
  }

  private async commitTask(e: Entry, startMs: number): Promise<void> {
    const t = this.boards.taskById().get(e.id);
    if (!t) return;
    const delta = startMs - e.startMs;
    const shift = (iso: string | null) =>
      iso ? new Date(new Date(iso).getTime() + delta).toISOString() : null;
    await this.boards.updateTask(t.id, {
      ...(t.startAt ? { startAt: shift(t.startAt) } : {}),
      ...(t.dueAt ? { dueAt: shift(t.dueAt) } : {}),
    });
  }

  private askScope(): Promise<EditScope | null> {
    return new Promise((resolve) => {
      this.dialog
        .open<ScopeDialog, { action: 'move'; allowFollowing: boolean }, EditScope>(ScopeDialog, {
          data: { action: 'move', allowFollowing: navigator.onLine },
        })
        .afterClosed()
        .subscribe((s) => resolve(s ?? null));
    });
  }
}

const rectOf = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top };
};

const clampMin = (m: number, max = 24 * 60 - 15): number => Math.max(0, Math.min(max, m));

function readView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v && (VIEWS as readonly string[]).includes(v)) return v as View;
  } catch {
    /* storage unavailable */
  }
  return 'month';
}

function readFilters(): { meetings: boolean; events: boolean; tasks: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null') as Partial<{
      meetings: boolean;
      events: boolean;
      tasks: boolean;
    }> | null;
    if (raw)
      return {
        meetings: raw.meetings !== false,
        events: raw.events !== false,
        tasks: raw.tasks !== false,
      };
  } catch {
    /* storage unavailable or damaged */
  }
  return { meetings: true, events: true, tasks: true };
}

/** The next occurrence of an event at or after `now` (or the first one), for a link that opens "the event". */
function nextOccurrence(
  e: { startAt: string; endAt: string; rrule: string | null },
  _now: number,
): { originalStart: string; startMs: number; endMs: number } | null {
  const startMs = new Date(e.startAt).getTime();
  return {
    originalStart: new Date(startMs).toISOString(),
    startMs,
    endMs: new Date(e.endAt).getTime(),
  };
}
