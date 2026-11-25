# Notes: collaboration roadmap, overview

This folder plans the next stage of Notes as 18 phases (0–17). Read this file first. Each `phase-N.md` is self-contained but relies on the decisions, architecture and conventions below. `todo.md` is the checklist.

Today Notes is a single-user app: User → Notebooks → Categories → Pages, offline-first, with a Notes server (NestJS + MySQL), an Angular PWA and an Electron shell. The roadmap adds themes, teams, projects, chat, boards, a calendar, sharing, real-time co-editing and quotas, without breaking the rules in `notes-app-constraints` (website first, MySQL, TipTap JSON, offline sync).

## 1. Decisions (answered by the project owner, do not re-litigate)

| Topic | Decision |
| --- | --- |
| API location | Any origin. Build-time `NOTES_API_URL` (env, then `.env`, then an interactive question), written to `config.json` that can be edited after deploy. Server: `CORS_ORIGINS`, `COOKIE_SAMESITE`. Done in phase 0. |
| Realtime | Socket.IO gateway (chat, presence, notifications, live updates). Optional Redis adapter (`REDIS_URL`) for several server instances. Page co-editing uses Hocuspocus (Yjs) mounted on the same HTTP server. |
| Offline | Notebooks, boards, tasks, labels and calendar are readable and editable offline. On reconnect changes merge field by field. A field that conflicts is won by the server; the local value goes to **Local history** with one-click **Replace** (re-apply local) and **Add as new**. Chat is online-first: cached read, queued sends. |
| Co-editing | Real-time Yjs co-editing for every page (private ones too), so there is one editor path. Offline edits merge as CRDT updates; pre-merge snapshots also go to local history. |
| Hierarchy | Team → Project → Sub-project (any depth). Team roles like Discord server roles. Projects add project roles and per-role/per-member allow/deny overwrites; overwrites inherit down the tree. A sub-project member must be a member of its parent. |
| Teams | Only instance admins create teams (`ADMIN_EMAILS`). The admin names the owner by email; with no account yet the person is invited and becomes owner on registration. Ownership can be transferred. Joining: email invites (works before the account exists), invite links (expiry, max uses, revocable), public directory with a per-team policy: anyone can join, or request to join. |
| Chat scope | Markdown, edit/delete, mentions, attachments with image previews, reactions, replies, pins, threads. DMs are 1:1 and only between people who share a team. Out of scope: group DMs, typing indicators, read receipts (a private last-read marker is kept for unread counts). |
| Notifications | In-app (bell, inbox, unread badges) + Web Push (VAPID; PWA and Electron). **Email is a separate per-chat option**: off / mentions only / every message, "only when I'm not active" on by default. |
| Mentions | `@member`, `@role`, `@everyone`, `@here`, each with its own mute/suppress option. |
| Share links (private notebooks) | Read link works anonymously; edit link needs a login. Revocable, optional expiry and password. Notebooks can also be shared directly with users (read / edit). |
| Calendar | Tasks with dates + meetings + personal events. ICS only for external calendars: a private subscription feed, subscribing to external ICS URLs (read-only), `.ics` import. No OAuth. |
| Extras | Personal boards/tasks, recurring meetings (RRULE, exceptions) with RSVP, team audit log, voice/video channels. |
| Quotas | Env defaults plus per-user/team/project overrides set by an instance admin. A `QuotaPolicy` interface lets plans/billing replace this later. Project usage counts toward its team. |
| Themes | light, dark, purple, red, green, blue, dark blue. Stored per account and restored at login. Nothing chosen → OS light/dark. Coloured themes are dark, with the colour as accent; the background does not have to be the main colour. |

## 2. Architecture

### 2.1 Spaces
Everything that holds content belongs to a **Space**:

```
Space { id, kind: personal | team | project, userId?, teamId?, projectId?, changeSeq BIGINT, storageUsedBytes BIGINT }
```
- A personal space exists per user. A team and each project/sub-project owns exactly one space.
- `Notebook`, `Board`, `Channel`, `Event`, `Label`, `Media` carry `spaceId`. Today's per-user `userId` ownership and `User.changeSeq` move to the Space.
- Sync cursors are per space: `GET /api/sync/changes?cursors={spaceId:seq}` returns changed rows, tombstones, and `revokedSpaces` (spaces the user lost access to, so the client purges them).
- `ChangeSeqService` keeps its pattern: `UPDATE Space SET changeSeq = changeSeq + 1 WHERE id = ?` inside the write transaction. The row lock keeps seq gap-free and ordered per space.

### 2.2 Hierarchy

```
Instance
 ├─ Personal space (per user)
 └─ Team  (the "guild")            owner, roles, members, invites, public listing, audit log
     ├─ team space (notebooks, boards, channels, calendar)
     └─ Project                    project roles + overwrites
         ├─ project space
         └─ Sub-project …          any depth, inherits overwrites
```
Breadcrumbs always show `Team / Project / Sub-project`.

### 2.3 Permission engine (`packages/shared/src/permissions/`)
A BigInt bitfield, computed by the same code on the server (guards) and in the web UI (hide/disable).

Resolution for member M in context C (team, project chain, optionally a channel):
1. M is the team owner, or holds `ADMINISTRATOR` through any role → every permission.
2. `base` = permissions of `@everyone` | all of M's team roles.
3. For each level from the root project down to C's project, then the channel: apply `@everyone` deny/allow, then the union of M's roles' deny, then allow, then M's own member deny/allow. Deny is cleared by a later allow only at a more specific level or by a member-specific allow (Discord semantics).
4. Result is masked: no `VIEW_*` for a container → every permission there is removed.

Rules: you cannot grant a permission you lack; you cannot edit a role at or above your highest role; the owner is above all roles. Not-found beats forbidden: a resource the caller cannot view answers 404.

Storage: `BIGINT UNSIGNED` columns; JSON as decimal strings. The engine stays below 64 bits.

| Bit | Name | Bit | Name | Bit | Name |
| --- | --- | --- | --- | --- | --- |
| 0 | ADMINISTRATOR | 13 | SEND_IN_THREADS | 26 | ASSIGN_TASKS |
| 1 | MANAGE_TEAM | 14 | MENTION_EVERYONE | 27 | MANAGE_BOARDS |
| 2 | MANAGE_ROLES | 15 | MANAGE_MESSAGES | 28 | MANAGE_LABELS |
| 3 | MANAGE_MEMBERS | 16 | MANAGE_CHANNELS | 29 | VIEW_CALENDAR |
| 4 | CREATE_INVITES | 17 | VIEW_NOTEBOOKS | 30 | CREATE_MEETINGS |
| 5 | VIEW_AUDIT_LOG | 18 | CREATE_NOTEBOOKS | 31 | MANAGE_MEETINGS |
| 6 | MANAGE_PROJECTS | 19 | EDIT_PAGES | 32 | ADD_TO_MEMBER_CALENDARS |
| 7 | VIEW_CHANNEL | 20 | DELETE_PAGES | 33 | CONNECT |
| 8 | SEND_MESSAGES | 21 | MANAGE_NOTEBOOKS | 34 | SPEAK |
| 9 | READ_MESSAGE_HISTORY | 22 | SHARE_NOTEBOOKS | 35 | VIDEO |
| 10 | ATTACH_FILES | 23 | VIEW_BOARDS | 36 | SCREEN_SHARE |
| 11 | ADD_REACTIONS | 24 | CREATE_TASKS | 37 | MUTE_MEMBERS |
| 12 | CREATE_THREADS | 25 | EDIT_TASKS | 38 | MOVE_MEMBERS |

Bits 39–63 are reserved. Each phase introduces its bits and tests them; no phase renumbers existing bits.

### 2.4 Realtime
- One Socket.IO connection per client, authenticated with the access JWT in the handshake; re-authenticated whenever the token refreshes.
- Rooms: `user:<id>`, `space:<id>` (metadata changes), `channel:<id>`. A client joins a room only after a permission check, and is removed when permissions change.
- Server → client events are *domain events* published on an internal bus (`EventBus`), never emitted from controllers directly.
- Hocuspocus handles `/api/collab` (Yjs). Both honour `CORS_ORIGINS` and the configured API origin.

### 2.5 Offline and merge (phase 15 completes it)
Every syncable entity has per-field versions (`fieldSeq`). A pushed change lists the fields it touched and the server version it was based on. The server merges non-overlapping fields; for an overlapping field the server's value wins and the rejected local value is returned and stored in `LocalHistory`.

### 2.6 Quotas (phase 2)
`QuotaService.check(scope, bytes)` is called by every write that stores bytes: media, attachments, documents. Scopes: `user` (personal space), `team`, `project`. Limits resolve: override → plan → env default. Exceeding a limit returns `413 {code:"quota_exceeded", scope, limit, used}`.

## 3. Glossary
- **Instance admin**: an email listed in `ADMIN_EMAILS`. Manages teams and quotas. Not a team role.
- **Team / Project / Sub-project**: see 2.2. Teams play the role of Discord guilds.
- **Space**: the container that owns content and the sync cursor (2.1).
- **Overwrite**: a per-level allow/deny pair for a role or a member.
- **Channel**: a chat room (text) or voice room in a space. **Thread**: a branch off one message. **DM**: 1:1 conversation.
- **Local history**: per-device record of local changes that lost a merge, with Replace / Add as new.

## 4. Conventions for every phase

### 4.1 Phase file template
Goal · Depends on · In scope / Out of scope · Data model · API · Web UI · i18n keys · Security & permissions · Quota impact · Implementation steps · Acceptance criteria · Definition of done.

### 4.2 Tests
| Layer | Tool | Where | Notes |
| --- | --- | --- | --- |
| unit (shared) | Vitest | `packages/shared/src/**/*.test.ts` | pure logic: permissions, merge, RRULE expansion, markdown, ICS |
| unit (scripts) | `node --test` | `scripts/lib/*.test.mjs` | build helpers |
| server | Vitest + supertest on the real Nest app and **real MySQL** (`notes_test`) | `apps/server/test/*.test.ts`, helpers in `test/app.ts`, `test/helpers.ts` | tests that need env set `process.env` before `createTestApp()`; restore afterwards |
| web e2e | `node --test` + Playwright (real Chrome) | `apps/web/e2e/*.e2e.mjs`, harness `harness.mjs` | `startStack()` runs the real server; `startSite()` serves the build from another origin; multi-user tests use one `device()` per user |
| desktop | `node --test` + Playwright `_electron` | `apps/desktop/e2e/*.e2e.mjs` | needs the Windows build |
| manual | checklist in the PR | – | only where automation is unreasonable (camera, OS notification UI) |

Rules: every acceptance criterion names its layer; every authorization rule has a test for *allowed*, *denied* and *not a member (404)*; every new endpoint is added to the fuzz list in phase 17; every user-visible string exists in `en.json` and `pt.json` (`node scripts/i18n-check.mjs`).

### 4.3 Definition of done (all phases)
1. All acceptance criteria green.
2. The full regression passes: `npm test`, `npm run e2e`, `npm test -w @notes/desktop`.
3. `node scripts/i18n-check.mjs` passes; `npm run format:check` passes.
4. README updated where behaviour or configuration changed; `.env.example` and `docker-compose.yml` updated for new settings.
5. Migrations are forward-only, tested on a database with data from the previous phase.
6. `phases/todo.md` ticked.

## 5. Dependency map

```
0 ──► 1
0 ──► 2 ──► 3 ──► 4 ──► 5
              3 ──► 6 ──► 7 ──► 8 ──► 9
              3 ──► 10 ──► 11
              6 ──► 12 ──► 13 ──► 14
        (10,12,13) ──► 15
              6,7 ──► 16
                  all ──► 17
```
Strict chains: 3 → 4 → 5 and 6 → 7. Phases 12–14 may start as soon as 6 is done. Phase 1 (themes) is independent and can ship early.
