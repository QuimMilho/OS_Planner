# Phase 13: Calendar and meetings

## Goal
A calendar that combines every task that has a date with meetings and personal events. People with the right role and permission can put meetings on other people's calendars, using the same allow/deny permission system as everything else. Meetings can recur and attendees can answer.

**Depends on:** 12 (task dates), 4, 6; 9 for reminders. **Needed by:** 14, 15.

## In scope / Out of scope
- In: events (`meeting`, `event`), attendees by user and by role, RSVP, recurrence (RRULE with exceptions and overrides), time zones, all-day, reminders, task dates shown as read-only items, views, filters by space, availability hints, `ADD_TO_MEMBER_CALENDARS`, video link field, offline.
- Out: external calendar sync other than ICS (phase 14), room/resource booking, free/busy publishing, scheduling assistant beyond simple conflict hints, built-in video meetings (phase 16 voice channels can be linked as the meeting location).

## Data model
```
Event        { id, spaceId?, ownerId, kind: meeting|event, title, description (Markdown), location?, videoUrl?, linkedChannelId?,
               startAt DATETIME(UTC), endAt, allDay BOOL, timezone VARCHAR(64), rrule TEXT?, rruleUntil DATETIME?, seq, createdAt, updatedAt, deletedAt }
EventException { id, eventId, originalStart DATETIME, kind: cancelled|override, override JSON? (title, start, end, location, …) }
Attendee     { eventId, kind: user|role, subjectId, status: invited|accepted|declined|tentative, respondedAt?, addedBy, optional BOOL }   PK (eventId, kind, subjectId)
Reminder     { id, eventId?, taskId?, userId, minutesBefore, sentAt? }                                  per-user reminders (defaults in settings)
UserCalendarSetting { userId, defaultTz, weekStart, defaultReminders JSON, shownSpaces JSON }
```
- `spaceId NULL` = personal event; otherwise the event belongs to a team/project space and is visible to those who can `VIEW_CALENDAR` there **and** are attendees (or the event is marked `visibility = space`).
- Times stored in UTC plus the event's IANA zone; recurrence is evaluated in that zone so DST behaves (e.g. "every Monday 09:00 Europe/Lisbon").
- Expansion is on read: `GET /api/calendar?from&to` expands RRULEs within the window (cap 2 years) with exceptions applied; nothing is materialised.

## Permissions (bits 29–32)
`VIEW_CALENDAR`, `CREATE_MEETINGS` (create in a space), `MANAGE_MEETINGS` (edit/cancel others' meetings), `ADD_TO_MEMBER_CALENDARS` (invite individual members or roles; without it a creator can only invite themselves and people who can already see the event's space calendar and have opted in to "open" invites). The invited person always sees who added the event and may decline or leave (`declined` removes it from their agenda but leaves the audit trail). Overwrites can target a project (calendar view of that project).

## API
- `GET /api/calendar?from=&to=&spaces=&include=tasks,meetings,events` → expanded items for the caller: own personal events, events they attend, space events they may view, tasks assigned to them with `startAt/dueAt` (read-only entries pointing at the task). Items carry `source` (`event|task`), `spaceId`, `colour`, RSVP state, conflict flags.
- Events: `POST /api/events`, `GET/PATCH/DELETE /api/events/:id` with `scope=this|following|all` for recurring edits (creates exceptions or splits the series), `POST /api/events/:id/rsvp {status, scope}`, attendee add/remove (`ADD_TO_MEMBER_CALENDARS`), `POST /api/events/:id/duplicate`.
- Settings: `GET/PUT /api/me/calendar-settings`.
- Sync: events and exceptions are included per space/personal space; attendee state of the caller is synced for offline agenda. Reminders are computed server-side and delivered through the phase 9 pipeline (in-app, push, email if enabled).
- Events on the bus: `event.created|updated|cancelled`, `event.invited`, `rsvp.changed`, `reminder.due`.

## Web UI
- `/app/calendar`: **Month / Week / Day / Agenda**, today button, mini-calendar, per-space colour toggles (personal, each team, each project), filter *tasks / meetings / events*, drag to move/resize events (respecting permissions), click-drag to create, keyboard navigation.
- Event dialog: title, time, time zone picker, all-day, repeat (presets + custom RRULE builder in plain language), attendees (people and roles with presence/availability hint), location/video link or "voice channel", reminders, description (Markdown), RSVP buttons, "who added this". Edit scope prompt for recurring events.
- Task entries open the task drawer; their date can be changed by dragging when the user may edit the task.
- Team/project calendar tab (events of that space). Rail badge for pending invites.
- Offline: calendar window of the last 2 months/next 6 months cached; creating/editing events offline queued; RSVP offline queued (merge in phase 15).

## i18n keys
`calendar.*` (views, today, newEvent, allDay, repeat presets, scopes), `rsvp.*`, `event.*`, `reminder.*`, `rrule.*` (natural language pieces en + pt), `timezone.*`.

## Security & permissions
- Calendar entries leak nothing about spaces the caller cannot view: tasks from boards the user lost access to disappear (tombstoned via sync).
- Attendees by role are expanded at read time to current role members who can view the space; removal from the role removes the event from their agenda.
- Adding someone to a calendar needs `ADD_TO_MEMBER_CALENDARS` in that space; you cannot add people who are not members of the space's team. Mass invites capped (500 people, 10 roles).
- Recurrence input validated (max occurrences/length, no `COUNT` over 3650, no `BYSECOND` abuse) to prevent expansion DoS; expansion limited per request.
- Descriptions are Markdown rendered through the safe renderer.

## Quota impact
Events are tiny and counted as documents bytes (size of description + metadata) against the owning space (personal events: the user). Recurrence rules and exceptions are bounded. No attachments in this phase.

## Implementation steps
1. Shared RRULE helper (expansion with exceptions, DST-correct) + natural-language formatter; unit tests with a reference table (`rrule` library wrapped, fixtures in en/pt).
2. Models + sync + expansion endpoint, attendees, RSVP, reminders worker (cron every minute, idempotent via `Reminder.sentAt`).
3. Permissions and overwrites; events/notifications integration.
4. Calendar UI (views, dialogs, drag/resize), settings.
5. Offline cache and queue; docs.

## Acceptance criteria
1. [unit] Expansion: daily, weekly (by day), monthly (by month day and by "2nd Tuesday"), yearly, `UNTIL`, `COUNT`, `EXDATE`, overrides, across a DST change in `Europe/Lisbon` and `America/New_York`, and all-day events — against fixed fixtures.
2. [server] Calendar endpoint returns own events, attended events, viewable space events and assigned tasks with dates; excludes everything else; window and expansion caps enforced.
3. [server] Permission matrix: create meeting needs `CREATE_MEETINGS`; inviting others needs `ADD_TO_MEMBER_CALENDARS`; non-members of the team cannot be added; denied/non-member (404) paths.
4. [server] Editing "this", "following" and "all" occurrences yields the expected exceptions/series split; cancelling one occurrence keeps the rest.
5. [server] RSVP: attendee-only; status propagates to the organiser's view; role attendees expand correctly and update when role membership changes.
6. [server] Reminders fire once (idempotent under two workers), respect user defaults and mute settings, and arrive through in-app + push (+ email if enabled).
7. [server] Losing access to a space removes its events and task entries from the caller's calendar on next sync (`revokedSpaces`).
8. [web e2e] Month/week/day/agenda switch; a task with a due date and a meeting appear on the right days; dragging a meeting changes its time and the attendee sees it live; a read-only user cannot drag.
9. [web e2e] A with `ADD_TO_MEMBER_CALENDARS` invites B and role R; B and R members see it with "added by A"; B declines → disappears from B's agenda; without the permission the attendee picker only offers "me".
10. [web e2e] Recurring weekly meeting: edit one occurrence; cancel another; the series renders correctly across a DST boundary (`page.clock`).
11. [web e2e] Offline: agenda loads from cache; an event created offline appears after reconnect; RSVP made offline is applied.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).

## Result

Done. Where the build differs from the plan above, and what later phases must know:

- **Server: `apps/server/src/calendar/`.** `EventsService` (create, change, cancel, answer, people, reminders, duplicate), `CalendarViews` (`GET /api/calendar`, who can be named, settings), `RemindersService`
  (sweeps, nightly clean-up), `EventAccess` (an event + what the caller may do with it), `CalendarEvents` (bus). Models: `Event`, `EventException`, `EventAttendee`, `EventReminder`, `ReminderDelivery`,
  `UserCalendarSetting`. Bits 29–32 already existed. `PermissionService` gained `calendarSpaces`, `requireCalendarSpace`, `calendarPermissions`, `heldRoleIds` and `spaceViewers` (who holds a bit in a space,
  in a handful of queries; used to expand roles). `NotificationService.onMeeting` writes the inbox rows (kinds `meeting_invite|updated|cancelled|response|reminder`, `targetKind: 'event'`, opening
  `/app/calendar?event=<id>`); push uses `meetingPush` in `copy.ts`; `MailService.sendMeetingReminder` for the email option.
- **Every event has a space.** The plan said `spaceId NULL` for personal events; here a personal event lives in the owner's personal space (so it has a sync cursor and a quota like everything else) and is
  the owner's alone (no attendees; 422 `no_attendees_in_personal`). Team and project events carry the space's `seq`. The owner is always an attendee row (accepted), so counts and "added by" are uniform.
- **Who sees an event** (`canSee` in `event-views.ts`): the owner, whoever holds MANAGE_MEETINGS in the space, everybody with VIEW_CALENDAR when `visibility = 'space'`, a user named on it, a holder of a role
  named on it. Anybody else gets 404. A role member who answers gets a user row of their own (so a declined answer survives leaving the role). Role changes bump the `seq` of the events that name a role
  (`CalendarModule` listens to `team.audited` for role/member/overwrite actions), which is how `hiddenEvents` reaches a person who left the role.
- **Sync.** `SpaceChangesDto` gained `events` (as the caller sees them: `me`, counts, the exceptions inside the event row) and `hiddenEvents` (changed rows the caller may not see: drop). A space is asked for when its
  calendar is visible too. New ops `event.create|update|cancel|rsvp` in `POST /api/sync/batch` (the outbox folds a plain `event.update` into a queued create; `this`/`following` scopes are never folded). The
  per-space answer of the migration test now carries `events: []`. The client keeps every synced event in Dexie (`events`, v8) and expands repeats itself with the shared code, so the calendar works offline;
  `GET /api/calendar` is the same expansion on the server (for other programs and ICS in phase 14), capped at 731 days and 5000 entries (`truncated`).
- **Recurrence** (`@os-planner/shared/calendar`, a fifth entry): an own RRULE subset instead of the `rrule` library (no time-zone support worth having, and the initial bundle is nearly full): FREQ DAILY|WEEKLY|MONTHLY|YEARLY,
  INTERVAL ≤ 999, COUNT ≤ 3650 or UNTIL, BYDAY (with ordinals in MONTHLY/YEARLY), BYMONTHDAY, BYMONTH, BYSETPOS (MONTHLY/YEARLY), WKST. Anything else (BYSECOND, BYHOUR, BYYEARDAY, RDATE…) is refused with 422, which also bounds
  expansion (20 000 periods per call). Evaluated on the wall clock of the event's zone: a time in the gap moves forward, a time that happens twice is the first (tested for Lisbon and New York). All-day events are midnight UTC
  with end exclusive and zone `UTC`. Phase 14 must map unsupported rules on import.
- **Editing a series.** `scope=this` (needs `occurrence`, validated against the rule) makes or updates an `EventException` (title, description, place, link, start, end only); `all` changes the event and drops exceptions
  when the start, zone, all-day flag or rule changes; `following` ends the old series (`UNTIL` one second before, `COUNT` turned into the right number for each half), creates a new event with a new id (attendees, reminders and the
  later exceptions move over) and returns it. Cancelling works the same; cancelling a whole event leaves a tombstone for 30 days (storage refunded at once). Exceptions per event ≤ 500.
- **Reminders.** `EventReminder` holds a person's own list for one event (no row: their `defaultReminders`, 10 minutes unless changed; `[]` is "none"); `ReminderDelivery` (person, occurrence, lead) is inserted in the same
  transaction as the notification and its primary key makes it once-only under any number of workers (a duplicate is a `P2002`, skipped). A sweep every minute handles leads up to a day, one at :07 each hour handles up to a week
  (so those may be up to an hour late); a lead is at most a week (`CALENDAR_LIMITS.reminderMaxMinutes` = 10 080). Muted teams get nothing in the inbox or push; the
  delivery is recorded anyway. Email goes out when `UserCalendarSetting.emailReminders` is on. `reminder.due` goes to the person's room. Task reminders are not here (tasks keep phase 12's "due soon" notice).
- **Realtime.** The room of the space hears only `{spaceId, id}`; the people on the event are also told in `user:<id>` (`event.invited`, and `event.updated` with the audience). The client pulls on any of them.
- **Quota.** Text of the event, its rule and exceptions counts as documents of the space (`eventBytes`); a cancel refunds.
- **Web.** `data/calendar-store.ts` (Dexie rows, permissions and settings in `meta`, offline create/update/cancel/answer), `features/calendar/` (`calendar-page` with month/week/day/agenda, mini calendar, filters, per-space
  switches, settings; pointer drag to move, resize and create; `event-dialog` with the repeat builder, people picker, answers, reminders; `cal-util`). Colours come from the space id (no colour column). A "Calendar" link with a badge of pending
  invitations is in the sidebar footer (not in the team rail); each team's and project's sidebar links to its own calendar (`?space=`). The initial bundle is 2.18 MB of the 2.2 MB limit.
- **Not done / left for later phases:** an answer is for the whole series only (`scope` other than `all` is 422); no per-person availability hint in the picker (only the overlap warning); no calendar window cache (the whole local
  copy is used); no linked voice channel in the UI (`linkedChannelId` is accepted and checked; phase 16); the "following" scope and naming people are online-only; per-field merge is phase 15.
- **Proxy.** No change to `deploy/nginx/os-planner.conf.template`: everything is under `/api/` and uses the existing realtime WebSocket. No new environment variables.
- **Tests.** shared +31 (`calendar/calendar.test.ts`), server +33 (`calendar.test.ts`) +1 (migration), web e2e +4 (`calendar.e2e.mjs`).
