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
