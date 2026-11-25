# Phase 14: ICS feeds and import

## Goal
Connect the calendar to the outside world using only the open ICS format: every person gets a private subscription link that Google Calendar, Outlook and Apple Calendar can follow, can subscribe to external ICS calendars (read-only), and can import `.ics` files. No OAuth, no provider-specific code.

**Depends on:** 13. **Needed by:** 15 (offline treats feeds as read-only data).

## In scope / Out of scope
- In: per-user outbound feed with source selection, regenerable secret URL, external ICS subscriptions with scheduled refresh, `.ics` import with preview, export of a single event/calendar as `.ics`, SSRF-safe fetching, `VTIMEZONE`/`RRULE`/`EXDATE`/`VALARM` support, provider fixtures (Google, Outlook, Apple).
- Out: two-way sync, CalDAV, OAuth integrations, free/busy sharing (listed as later work if requested).

## Data model
```
CalendarFeed        { id, userId, tokenHash CHAR(64) UNIQUE, tokenHint CHAR(6), name, include JSON (spaces[], tasks bool, meetings bool, events bool, declined bool), createdAt, rotatedAt?, lastFetchedAt?, fetchCount }
ExternalCalendar    { id, userId, name, url TEXT, color, etag?, lastModified?, lastSyncAt?, lastError?, syncEveryMinutes INT default 60, enabled BOOL, createdAt }
ExternalEvent       { id, calendarId, uid, recurrenceId?, startAt, endAt, allDay, timezone, title, description, location, rrule?, exdates JSON?, raw TEXT?, sequence INT, updatedAt, deletedAt }     unique (calendarId, uid, recurrenceId)
ImportJob           { id, userId, spaceId?, status, totals JSON, createdAt }  (optional audit of imports)
```
- External events are **separate** from `Event` (never editable, never charged to attendee flows) and enter the calendar endpoint as `source: external`.
- Feed secret shown once at creation (and regeneration); only the hash and a short hint are stored.

## API
- Outbound: `GET /api/me/feeds`, `POST /api/me/feeds {name, include}`, `PATCH /api/me/feeds/:id`, `POST /api/me/feeds/:id/rotate`, `DELETE /api/me/feeds/:id`. Public feed URL: `APP_URL/feeds/<token>.ics` (served by the API origin; the URL shown to people uses the API origin that browsers/calendar apps can reach: `NOTES_API_URL || APP_URL` — an explicit exception to phase 0 rule 3, documented in the UI help).
- Feed response: `text/calendar; charset=utf-8`, `ETag`/`Last-Modified` support (`304`), `Cache-Control: private, max-age=300`, `X-PUBLISHED-TTL`/`REFRESH-INTERVAL`; events as `VEVENT` with stable `UID`s (`<id>@<host>`), recurrence rules, exceptions as `RECURRENCE-ID`, tasks with dates as `VEVENT` (or `VTODO` option), attendee `PARTSTAT`, `VALARM` from the user's reminders. No private spaces beyond the selection; declined events excluded unless enabled.
- External subscriptions: `GET/POST /api/me/external-calendars`, `PATCH/DELETE …/:id`, `POST …/:id/refresh`, `GET …/:id/events` (via the calendar endpoint).
- Import: `POST /api/calendar/import` (multipart `.ics`, `spaceId?`, `mode: preview|commit`) → preview lists events found, unsupported components, duplicates (same `UID` already imported); commit creates `Event` rows owned by the user (personal or in a space when they hold `CREATE_MEETINGS`).
- Export: `GET /api/events/:id.ics`, `GET /api/calendar/export?from&to&spaces=` (authenticated download).

## Fetching external calendars safely
- Only `http:`/`https:`/`webcal:` (rewritten to https then http fallback if allowed by `ICS_ALLOW_HTTP`, default false in production).
- DNS resolved once and the **resolved IP** checked against private/loopback/link-local/CGNAT/metadata ranges (IPv4 and IPv6, including IPv4-mapped); connection pinned to the checked IP; every redirect re-checked (max 3); `Host` header retained for TLS SNI; credentials in URLs rejected.
- Limits: 5 MB, 20 s total, `text/calendar` or `text/plain` accepted, gzip allowed, per-user caps (10 subscriptions, one refresh per 5 min per calendar, global concurrency 4). Conditional requests with `ETag`/`If-Modified-Since`; exponential backoff and `lastError` after repeated failures; auto-disable after 14 days of failures with a notification.
- Parser is isolated with a time and memory guard (maximum events 20 000, maximum recurrence expansion as in phase 13); malformed components are skipped and counted.
- A scheduler (`@nestjs/schedule`) refreshes due calendars with jitter; multi-instance safe through a DB lease row.

## Web UI
- Settings → **Calendar sync**:
  - *Subscribe from other apps*: create a feed (what to include), copy URL, QR code, per-app instructions (Google, Outlook, Apple), rotate/delete, last fetched time.
  - *Other calendars*: add by URL with name and colour, status, refresh now, error details, remove.
  - *Import / export*: drag a `.ics`, preview table with checkboxes, choose destination (personal or a space), result summary; export current range.
- Calendar view shows external events muted, with a colour per source and a lock icon; clicking shows details and "open in source" when a `URL` exists.

## i18n keys
`calendarSync.*` (feed, external, import, export, instructions, errors), `ics.error.*` (blocked address, too large, timeout, not a calendar, too many events).

## Security & permissions
- The feed URL is a bearer secret: unguessable, revocable, never logged in full, excluded from `Referer` (`Referrer-Policy: no-referrer`), rate limited per token, 404 for unknown/rotated tokens identical to nonexistent routes.
- Feed content is computed with the owner's permissions at request time: losing access to a space removes its items on the next fetch.
- SSRF protections as above are covered by tests with a local HTTP fixture server and DNS stubs (rebinding, redirects to `127.0.0.1`, `169.254.169.254`, IPv6 loopback).
- Imports validate and sanitise text; HTML in descriptions is stripped to text/Markdown; attachments (`ATTACH`) are ignored.
- Importing into a space requires `CREATE_MEETINGS`; attendees in imported events are stored as plain text names and **never** become invited users.

## Quota impact
Imported `Event`s count as documents bytes for their owner/space; external events are stored for display and counted against the user's personal quota up to a fixed cap (`EXTERNAL_CALENDAR_MAX_MB`, default 5 per user). Exceeding refuses the subscription refresh, not existing data.

## Implementation steps
1. Shared ICS library wrapper (parse/serialise) with the provider fixture set under `packages/shared/src/ics/fixtures/`.
2. Feed models and endpoint with conditional requests.
3. Safe fetcher module + scheduler + external calendar models.
4. Import preview/commit and exports.
5. Settings UI, instructions, QR.
6. Docs (self-hosting: feed URL needs the public API address).

## Acceptance criteria
1. [unit] Round trip: events (single, recurring with exceptions, all-day, with `VALARM`, with time zones) serialise to ICS and parse back identically; fixtures from Google, Outlook and Apple import with the expected count and fields (including `VTIMEZONE` offsets and `RECURRENCE-ID` overrides).
2. [server] Feed: valid token returns calendar content; wrong, rotated and revoked tokens return the same 404; `ETag` produces 304; content reflects permissions (revoked space disappears); no private data outside the selection.
3. [server] SSRF suite: loopback, private ranges, link-local/metadata, IPv6 and IPv4-mapped addresses, DNS rebinding (first public then private answer), redirect to an internal address, `file:`/`gopher:` schemes, oversized body, slow response, wrong content type — all refused with the documented error and no outbound request to the internal target.
4. [server] Refresh honours `ETag`/`Last-Modified`, backs off after failures, auto-disables after the configured period, and respects per-user caps and the refresh cooldown.
5. [server] Import preview detects duplicates by `UID`; commit is idempotent (running twice creates no duplicates); importing into a space requires `CREATE_MEETINGS`; `ATTENDEE`/`ATTACH` never create users or files.
6. [server] Recurrence expansion guards: pathological `RRULE`s are rejected or capped without stalling the request (time-boxed test).
7. [web e2e] Create a feed; fetch its URL with a plain HTTP client (as a calendar app would) and verify the events created in the UI appear; rotate → the old URL is 404 and the new works.
8. [web e2e] Subscribe to an external ICS served by the test harness; its events appear muted in the calendar; changing the fixture and pressing refresh updates them; an internal address is refused with the friendly message.
9. [web e2e] Import a `.ics` with 3 events (one recurring), preview, uncheck one, commit; the two events show on the calendar; a second import reports duplicates.
10. [manual] Subscribe the feed in real Google Calendar, Outlook and Apple Calendar and confirm events, recurrence and reminders look right and refresh.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).
