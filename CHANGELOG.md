# Changelog

All notable changes to OS_Planner. Versions follow [Semantic Versioning](https://semver.org/); the desktop app updates itself to a
higher version only.

## 1.0.0 — the collaboration release (2026-11-27)

From a single-user notebook to a planner for teams. Everything below works in a plain browser; the desktop app and the PWA are the same website.

### Added

- **Themes** (light, dark, purple, red, green, blue, dark blue), stored per account, no flash on load.
- **Administration**: instance administrators (`ADMIN_EMAILS`), accounts, storage limits per person, team and project (`413 quota_exceeded`).
- **Teams, projects and sub-projects** with their own notebooks, boards, channels and calendars; **roles** at team and project level, allow/deny
  **overwrites** on projects, channels, notebooks and boards, an **audit log**.
- **Joining**: email invites (also before the account exists), invite links (expiry, uses, revocable), a public directory with "anyone can
  join" or "ask to join", leave, kick, ban, ownership transfer.
- **Live updates** over one Socket.IO connection (presence, permission changes, sync nudges), optionally shared between instances with Redis.
- **Chat**: channels with categories, Markdown, edit/delete, mentions, attachments, reactions, replies, pins, threads, unread counts, offline
  read and queued sends; **direct messages** between people who share a team, with per-team privacy and blocking.
- **Notifications**: `@member`, `@role`, `@everyone`, `@here`; levels and mutes per team, project and channel; inbox and badges; Web Push;
  email per chat (off, mentions, everything; "only when I am away").
- **Shared notebooks**: team and project notebooks, direct shares (read/edit), share links (anonymous read, login to edit, expiry, password).
- **Real-time co-editing** of every page (Yjs over Hocuspocus), with carets, snapshots and restore.
- **Boards and tasks**: columns with WIP limits, subtasks, checklists, labels, assignees, dates, comments with mentions, files, activity,
  personal boards, "My tasks", offline task changes, keyboard moves.
- **Calendar**: month, week, day and agenda; meetings with RSVP, recurrence (RRULE subset, exceptions), time zones, reminders.
- **Calendar sync (ICS)**: a private subscription feed, following outside calendars (SSRF-safe, scheduled refresh), `.ics` import and export.
- **Offline merge**: changes made offline merge field by field; what lost goes to the per-device **Local history** (Replace, Add as new, Dismiss).
- **Voice and video channels** on an optional LiveKit server: mute, deafen, camera, screen share, push to talk, moderation.
- **Automatic updates** of the PWA and the desktop app, applied when nothing is in progress.
- **Operations**: structured (JSON) logs with request ids and no secrets in them; `/api/health` per part (`?strict=1` for the container);
  Prometheus `/api/metrics` for administrators (or `METRICS_TOKEN`); `RATE_LIMIT_FACTOR`; backup and restore scripts
  (`scripts/backup.mjs`, `scripts/restore.mjs`); load and soak profiles (`scripts/load/`); a demo data set (`npm run seed:demo`).
- **Documentation**: architecture, permissions guide, self-hosting (proxy, TLS, Redis, LiveKit, VAPID, SMTP), the configuration reference
  generated from the server's schema (`docs/configuration.md`), backups, upgrading, threat model, FAQ.

### Changed

- Sync works per space (`GET /api/sync/changes?cursors=...`): one cursor for each personal, team and project space and for each shared notebook.
- A page's text is a co-edited document; a text a device kept goes up through `POST /api/pages/:id/snapshots/replace` (with an optional
  `baseVersion`: `409 version_conflict` when the page changed since).
- **Requests are strict**: a field a route does not declare is `400 "<field>: unknown field"` (bodies, query strings, socket payloads).
- "Not found" is one answer everywhere (`404 {"message":"not_found","error":"Not Found"}`): something hidden reads exactly like something missing,
  and deleting an id that does not exist is a 404 (deleting something already in the trash still succeeds).
- In production the server refuses to start with placeholder secrets (the ones of `.env.example`), a default database password, or the
  same value for both JWT secrets. JSON logs are the default there (`LOG_FORMAT`).
- The image's `HEALTHCHECK` asks `/api/health?strict=1` (the realtime server must be up as well).
- Reduced motion is honoured; new messages and notifications are announced to screen readers; board cards say how to move them with the keyboard.

### Removed

- `PUT /api/pages/:id/content` (use the co-editing connection, or `snapshots/replace` for a text kept on a device).
- `GET /api/sync/changes?since=` (the single cursor of the personal space) and the `User.changeSeq` column it read.

The **desktop app is 1.1.0**: it has its own version line (the single-user release shipped desktop 1.0.0, and an installed app only updates
to a higher number). It is the same thin window around the website, now with the media permission handler and silent updates.

### Upgrading from 0.1.0

Back up first (`node scripts/backup.mjs`). Then build and start the new version: the migrations run on start and keep every notebook, page,
file and account (they are rehearsed on a database with 0.1.0 data in `apps/server/test/migration.test.ts`). Set `MYSQL_PASSWORD` (and the
database user's password) if the instance still uses the default one, and replace any `change-me` secret: the server refuses to start otherwise.
Open devices update themselves on their next idle moment. See the README, "Upgrading".

## 0.1.0 — single-user release

Notebooks, categories and pages with a rich editor (math, diagrams, charts, function plots, code, images, video), PDF and Markdown export,
offline editing with sync, accounts (email/password, verification, reset), English and Portuguese, the desktop app for Windows and Linux.
