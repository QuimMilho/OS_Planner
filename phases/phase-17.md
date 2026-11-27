# Phase 17: Hardening and release

## Goal
Prove the whole system is safe, fast and documented enough to publish as a 1.0 of the collaboration release. No new features: close every gap the earlier phases deferred, test authorization exhaustively, set performance budgets, and finish self-hosting documentation.

**Depends on:** all earlier phases.

## In scope / Out of scope
- In: authorization fuzzing, security review, removal of compatibility shims, load and soak tests, bundle and startup budgets, accessibility, backup/restore, migration rehearsal, observability, documentation, release procedure.
- Out: new product features; third-party penetration test (recommended, not performed here).

## Work items

### A. Authorization (the biggest risk)
- A generated test enumerates **every REST route and socket/collab event** from the Nest route table and a manifest of socket events, and for each runs: anonymous, unverified user, authenticated non-member, member without the permission, member with it, banned user, removed member, owner, instance admin (who must *not* get team data unless a member). Expected result per route comes from a declarative table next to the controller (`@Authz({ needs: Permission.X, scope: 'team|project|channel|space|self|admin|public' })`); the test fails when a route has no declaration.
- Cross-tenant tests: IDs from team A used in team B routes, mismatched parent/child ids (task of board X under board Y), ids from deleted/archived containers, UUID guessing responses (identical 404 timing/shape).
- Mass-assignment tests: unknown fields rejected on every DTO; `userId`, `spaceId`, `permissions` never accepted from clients.
- Review checklist applied to each module: 404-vs-403 rule, ownership scoping in queries, transactional audit, rate limits, request size limits, logging without secrets.

### B. Compatibility shims and debt
- Remove `User.changeSeq` dual-write (phase 3) and the `?since=` cursor; remove `PUT /api/pages/:id/content` (phase 11) after clients are required to be current (service-worker update prompt forced one release earlier).
- Re-audit every `data/` ignore rule, CSP source and CORS option after all phases; confirm the generated config documents match README.
- Resolve open items recorded in earlier phases (phase 0's editor equation regression must already be fixed by phase 11).

### C. Performance and scale
- Load profiles (k6 or a Node script in `scripts/load/`): 2 000 concurrent sockets, a 1 000-member `@everyone` message, 100 users editing 20 pages, 50 concurrent syncs of a 5-space user, calendar expansion of 500 recurring events over a year, feed fetch by 1 000 calendar clients.
- Budgets (enforced in CI where feasible): API p95 < 200 ms for reads at the test dataset size, message fan-out p95 < 500 ms to 500 connected members, collab update propagation p95 < 300 ms, initial web bundle ≤ 520 kB gz (today ≈ 460 kB, record the real figure), each feature route lazy-loaded (boards, calendar, admin, voice, history each < 150 kB gz), cold start to interactive on the PWA < 3 s on a mid laptop with a warm service worker.
- Database: indexes verified with `EXPLAIN` for the hot queries (messages by channel/id, unread counts, sync by space/seq, calendar window, notification inbox); slow-query log reviewed; connection pool limits documented.
- Soak: 24-hour run with churn (join/leave, reconnect storms) — no memory growth beyond 20 %, no leaked rooms or timers.

### D. Accessibility and i18n
- Keyboard-only walkthroughs for rail, sidebar tree, chat, board drag/drop alternative (move via menu), calendar grid, dialogs; screen-reader labels, focus management, live regions for new messages and notifications (polite, throttled), reduced-motion support, colour contrast in all seven themes (phase 1 script re-run on new components).
- `axe-core` runs inside the e2e suite on each main screen; zero serious/critical violations.
- `node scripts/i18n-check.mjs` includes the new namespaces; pt-PT review of all strings by a native speaker; pluralisation and date/time formats verified.

### E. Operations
- Backup and restore guide and script: MySQL dump + `DATA_DIR` (uploads, downloads); restore rehearsal tested on a clean machine; migration rehearsal from the last release of the single-user app (data-preserving test uses a real dump fixture).
- Observability: structured logs with request ids, `/api/health` (db, storage, realtime, mail, optional livekit/redis), Prometheus-style `/api/metrics` for admins (sockets, rooms, queue lengths, store durations), log scrubbing of tokens and feed URLs.
- Rate-limit review (auth, invites, share links, feeds, directory, search, uploads, socket events) with documented defaults and environment overrides.
- Secrets: startup refuses default/placeholder secrets in production (`change-me…`), documented rotation steps for JWT, VAPID, LiveKit, feed tokens.
- Container: image size and non-root verified; `HEALTHCHECK` covers realtime; compose profiles (`prod`, `scale` with Redis, `voice` with LiveKit) documented and tested.

### F. Documentation and release
- README sections: architecture, permissions guide (Discord comparison table), self-hosting (reverse proxy examples for HTTP + WebSocket + SSE-free paths, TLS, `TRUST_PROXY`, Redis, LiveKit, VAPID generation, SMTP), configuration reference generated from `env.ts`, upgrade notes, backup guide, API address guide (from phase 0), threat model summary, FAQ.
- `CHANGELOG.md`, version bump, release notes; desktop and Linux builds published through the existing script; download page shows the new release.
- Demo seed script (`npm run seed:demo`): teams, projects, channels, boards, events for screenshots and manual testing.

## Implementation steps
1. Declare `@Authz` metadata on every controller and socket/collab handler; build the generated authorization test and make it fail on undeclared routes.
2. Run the cross-tenant, mass-assignment and "exists vs. missing" suites; fix findings before anything else.
3. Remove the compatibility shims (B) and rehearse the migration from the previous release.
4. Write and run the load and soak profiles; tune indexes, pools and fan-out; record the budgets.
5. Accessibility pass with `axe-core` in e2e plus the keyboard walkthroughs; pt-PT review.
6. Operations work (E): backups, metrics, startup secret checks, compose profiles.
7. Documentation and demo seed (F); the full-journey e2e; release.

## Acceptance criteria
1. [server] The generated authorization test passes for 100 % of routes and socket/collab events; adding a route without an `@Authz` declaration fails the build (a test asserts the coverage).
2. [server] Cross-tenant and mass-assignment suites pass; unknown fields are rejected on every DTO (generated from the zod schemas).
3. [server] Responses for "exists but forbidden" and "does not exist" are indistinguishable (status, body, and timing within a tolerance) across the enumerated routes.
4. [server] Shims removed: no code references `User.changeSeq` or `?since=` or the legacy content endpoint; migrations still apply on a database from the previous release (rehearsal test).
5. [load] Every budget in section C is met or the documented exception is recorded with an issue; soak shows no leaks.
6. [web e2e] `axe-core` finds no serious/critical violations on login, home, team view, channel, DM, board, task drawer, calendar, settings, share view, admin; keyboard-only flows complete (scripted with Playwright keyboard events).
7. [web e2e] The full journey runs end to end on a fresh install (seed script): admin creates a team → owner invited by email → registers → creates project/sub-project, roles and overwrites → invites a member by link → chat with mentions, mute and email → shared notebook co-edited by two people → board with tasks → calendar meeting with RSVP → ICS feed fetched → offline edit conflict resolved from Local history → theme persisted across devices.
8. [desktop] Updated desktop suite passes (shell connects to realtime, notifications, voice permission handler).
9. [manual] Backup → wipe → restore rehearsal; upgrade rehearsal from the previous release; documentation walkthrough by someone who did not write it (they stand up a two-instance Redis deployment from the README alone).
10. [manual] Security review sign-off: checklist in section A completed per module with the reviewer's notes stored in `phases/security-review.md`.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases), plus: release notes published, all `todo.md` boxes ticked, tag created (only when the owner asks for a commit/tag).

## Result

Built on 2026-11-27. Everything that can be automated here is, and ran; what needs people or other machines is listed under "Not done". Section by section:

### A. Authorization

- **Declarations.** Every REST route has `@Authz({ scope, needs, anyOf, author, ownerOnly, denied, verified, note })` next to it (`apps/server/src/common/authz.ts`; the admin controller declares it once on the class). Scopes: `public`, `secret` (a secret in the request is the key), `self`, `own` (a row of the caller's named in the path), `admin`, `release`, `webhook`, and the team places `team`, `project`, `space`, `channel`, `notebook`, `board`, `calendar`, plus `dm`. The realtime events, the joinable room kinds and co-editing are declared as data (`AUTHZ_SOCKET_EVENTS`, `AUTHZ_ROOMS`, `AUTHZ_COLLAB`). 252 routes (the content `PUT` went, `/api/metrics` came).
- **The generated test** (`apps/server/test/authz.test.ts`, 16 tests) reads Nest's route table (`test/routes.ts`: paths, methods, the `@Authz` rule, the zod schemas of body, query and params) and runs each route as ten people on a real team (anonymous, unverified, outsider, banned, removed, instance admin, a member with no permission at all, a viewer with the VIEW bits, a member with everything but ADMINISTRATOR, the owner): 2 380 calls, each answer compared with what the rule says. Bodies and queries are generated from the zod schemas (`sample()`), with a table of cases for routes that need real ids, a fresh item per allowed person (deletes, moves, restores), or tell a story of their own (leaving, handing a team over, joining, accepting invitations: own tests). The test fails for a route without a declaration, for a scope or permission name that does not exist, and when the server listens to a socket event that is not declared.
- **Hidden looks like missing** (acceptance 3): for every route where the outsider (or the member without the VIEW bit) must get 404, a real id and random ids (in the path, the body and the query) give the same status and the same body byte for byte, and the same time (median of three; every gap was under 1 ms, the test allows 75).
- **Across teams**: ids of a second team's checklist item, file, label, column, snapshot, join request, role, member and message used under the first team's routes are refused or are harmless no-ops, and nothing of the second team changes.
- **Mass assignment** (acceptance 2): `StrictSchemaPipe` (global) compares what came in with what the route's zod schema kept: a field nobody declared is `400 "<field>: unknown field"`, for bodies and query strings; the realtime gateway refuses socket payloads the same way. Not schema by schema: a deep comparison of input and parsed output, so nothing had to be rewritten and every future schema is covered. Sync operations inside a batch still drop unknown fields (refusing would lose offline work for an extra field; nothing unknown is applied). Fields that name a person or a place in a body are a reviewed list in the test (19 today).
- **Fixed**: see `phases/security-review.md` "Findings fixed" (the delete oracle, two 404 bodies, not-found messages that named what was missing, the sync-batch oracle, the concurrent text replacement, placeholder secrets, secrets in logs). The review checklist per module is in that file, **without the sign-off of a second person** (acceptance 10).

### B. Shims

- `User.changeSeq` is gone (migration `drop_user_change_seq`; `ChangeSeqService` no longer mirrors), so is the single `?since=` cursor (`cursors` is required) and `PUT /api/pages/:id/content`. The web sends a page text it kept outside the editor (Local history "Add as new", copies, a text from before co-editing) through `POST /api/pages/:id/snapshots/replace`, which now takes an optional `baseVersion` and answers like the old route did: `{ok, version}`, `409 version_conflict` with the server's version and text, `422 unknown_media`, `413 quota_exceeded`; a per-page lock makes two devices sending from the same version end with one winner, and what people in the page typed is stored first so the version is the live one. A page nobody wrote in gets no "before" snapshot. The migration test grows a database from the single-user release through every migration with data in between and syncs it with per-space cursors only (the rehearsal of acceptance 4).
- CSP, CORS and ignore rules re-read: CORS also allows and exposes `X-Request-Id`; `.gitignore`/`.prettierignore`/`.dockerignore` know `apps/server/.load-data/` and `/backups/`. Open items of earlier phases: the initial bundle (below); account deletion is **decided: not in 1.0** (content stays with its author's account; deleting accounts needs its own design for authored content, chats and owned teams).

### C. Performance and scale

- **Load** (`npm run load`, `scripts/load/run.mjs`; a server of its own on `notes_load`, the production build, throttling off; on the development machine). All budgets met:

  | Profile | Result | Budget |
  | --- | --- | --- |
  | 2 000 sockets (4 per person) | all connected, connect p95 270 ms; RSS 355 → 403 MB; afterwards 0 sockets, rooms back to 0 | — |
  | `@everyone` in a team of 1 000, 500 connected | delivery p95 **119 ms** (send 122 ms incl. planning 1 000 notifications) | < 500 ms |
  | 100 people editing 20 pages | propagation p95 **40 ms** (4 000 samples) | < 300 ms |
  | first sync of 5 spaces, 1 000 pages | alone p95 246 ms (several pages of answers); 50 at once p95 3.1 s (bound by the database pool of 10) | recorded |
  | a year of 500 weekly meetings | p95 **173 ms** (the answer is cut at 5 000 occurrences, `itemsPerRequest`; the app asks months or weeks) | < 200 ms |
  | 1 000 calendar feeds | one at a time p95 **45 ms**; all 1 000 at 20 at a time in 6.8 s (148/s) | < 200 ms |
  | everyday reads (me, teams, channels, messages, board, inbox, unread, search) | p95 18 – 60 ms | < 200 ms |

- **Bundles** (`npm run check:bundle` after `ng build --stats-json`): the initial bundle was **597 kB gzipped**: `core/theme.ts` (theme names) and `shell/tree.ts` (`Permission`) imported values from the main entry of `@os-planner/shared`, which pulled zod, TipTap/ProseMirror and KaTeX into the first load. They read `@os-planner/shared/lite` now (the theme list moved to the zod-free `dto/themes.ts`): **236 kB gzipped** (861 kB raw; the build's budget is now 950 kB warning / 1.1 MB error instead of 2.2 MB). Feature routes (own chunks, gzipped): boards 122 kB, calendar 27 kB, admin 5 kB, voice 5 kB, history 4 kB (all < 150 kB; the shared schema chunk, ~450 kB, is loaded once by the first app screen and kept by the service worker; livekit-client stays a chunk of its own loaded when joining a call).
- **Cold start** with a warm service worker: `apps/web/e2e/perf.e2e.mjs` (< 3 s; result under "Tests").
- **Database**: `test/explain.test.ts` checks the plans of the hot queries on a spread-out data set (chat history and catch-up, unread counts, sync of every synced table by space and sequence, the calendar window, the inbox and its count): each uses a bounded index. It found the inbox (read and unread together, newest first) without an index that orders it: migration `inbox_index` (`Notification(userId, createdAt)`). The pool size is `?connectionLimit=` on `DATABASE_URL` (default 10); the README says how to size it and how to turn on the slow-query log.
- **Soak** (`npm run soak -- --minutes=N`, `scripts/load/soak.mjs`): churn (connections come and go, reconnect storms, rooms joined and left, messages, people leaving and re-joining the team), sampled every 30 s from `/api/metrics`, then everything disconnected, garbage collected (`?gc=1` with `--expose-gc`) and compared with the baseline. Result under "Tests".

### D. Accessibility and i18n

- `apps/web/e2e/a11y.e2e.mjs` runs axe-core 4.14 (WCAG 2.0/2.1 A and AA, best practices) on the landing, sign-in, sign-up and password screens, the share view, home, team, channel, direct message, board, task drawer, calendar, settings, editor and administration, and fails on any serious or critical violation; it also does the keyboard flows (Tab to the composer and send, move a card with Alt+arrow and open it with Enter, a dialog closed with Escape gives the focus back) and checks the live regions and reduced motion. The app gained: `prefers-reduced-motion` switches transitions and animations off; polite, throttled live regions for new messages (one by author, several as a count, at most every 4 s) and new notifications (at most every 10 s); board cards carry `aria-keyshortcuts` and a described hint about moving them.
- `node scripts/i18n-check.mjs` passes (1 676 keys). The pt-PT texts were **not** reviewed by a native speaker.

### E. Operations

- `/api/health` reports `db`, `storage`, `realtime`, `mail` (+ `redis`, `livekit` when configured; mail and LiveKit checked at most once a minute), 503 only without the database or the storage; `?strict=1` also fails while the realtime server is down and is what the image's `HEALTHCHECK` asks. `/api/metrics` (Prometheus text) for instance administrators or a scraper with `METRICS_TOKEN`: memory, event-loop lag, active handles by type, requests and durations by route, realtime sockets/rooms/users/drops/refusals, co-editing documents/connections/stores/store time/refusals, emails waiting, calendars due, people in voice.
- Logs: `AppLogger` (Nest's console logger, JSON lines with `LOG_FORMAT=json`, the default in production; `LOG_LEVEL`) scrubs every line (`common/scrub.ts`: JWTs, bearer tokens, feed/link/invite secrets, query strings, push endpoints, `password=` pairs); each API request is one line with its id (`X-Request-Id`, the caller's if it is a plain token; nginx passes `$request_id`), method, path without query, status, time and user (`LOG_REQUESTS`).
- Rate limits reviewed and documented (README "Rate limits"); search routes got their own (60/min); `RATE_LIMIT_FACTOR` scales them all (`ScaledThrottlerGuard`).
- Secrets: in production the server refuses the placeholders of `.env.example`, repeated characters, a default database password and equal JWT secrets; rotation steps for every secret are in the README.
- Backups: `npm run backup` / `npm run restore` (`scripts/backup.mjs`, `scripts/restore.mjs`, `scripts/lib/backup.mjs` with unit tests): one consistent mysqldump (inside the compose `mysql` service, or from the PATH) and a tar of `DATA_DIR`, with a manifest; restore replaces both and runs the migrations. Rehearsed here: the demo instance backed up, restored into another database and folder, 64 tables / 180 rows identical. The configuration reference is generated (`docs/configuration.md`, `npm run docs:config`; a script test fails when it is stale).
- Container: the image already ran as `node` (non-root) with a `HEALTHCHECK`; the check is now strict. Compose passes the new settings.

### F. Documentation and release

- README: architecture, permissions at a glance (compared with Discord), running it (logs, health, metrics, database), rate limits, secrets and rotation, backups, upgrading, two instances with Redis, threat model, FAQ; the configuration table became the generated reference. `CHANGELOG.md` (1.0.0, with upgrade notes). Versions: 1.0.0 everywhere except the **desktop shell, 1.1.0** (it was 1.0.0 since the single-user release, and installed apps only update to a higher number).
- `npm run seed:demo` (`scripts/seed-demo.mjs`): a team with projects and a sub-project, an owner, a lead, two members and a guest (with roles), channels, a thread, a pin, a direct conversation, notebooks with pages, a share link, a board with labels, checklist and comments, a weekly meeting with attendees, a feed; through the API of a running server (only "verified" is written to the database); a second run does nothing. Tried on a fresh server.
- `apps/web/e2e/journey.e2e.mjs`: the full journey of acceptance 7 in one test (result under "Tests").

### Tests

- **Server** 711 (35 files; MySQL, and Redis for the two-instance tests): new `authz.test.ts` (16: declarations, every route × 10 people, routes with a story of their own, wrong secrets, hidden = missing, across teams, rooms and co-editing, mass assignment), `ops.test.ts` (7: health, metrics access, request ids, log scrubbing, secrets at start-up), `explain.test.ts` (5), the migration test (+2: `drop_user_change_seq`, `inbox_index`; the rehearsal now syncs with per-space cursors only); tests that used the removed routes moved to `snapshots/replace` and cursors.
- **Shared** 411. **Build scripts** 29 (+6: the configuration reference, backups). **Themes** 82 contrast checks.
- **Web e2e**: `a11y.e2e.mjs` (5), `journey.e2e.mjs` (1, the whole of acceptance 7), `perf.e2e.mjs` (1: 131 – 136 ms to the app with a warm service worker on this machine, budget 3 s), and phase 16's four real-media voice tests now run (with `livekit/livekit-server` in Docker). The complete run: see "Final run" below.
- **Load** (full size) and **soak** (10 minutes, 6 208 churn actions: heap after garbage collection +1.9 %, sockets 0, rooms 0, timers 11 → 11): as in section C.
- **Bundles**: `npm run check:bundle` passes (numbers in section C).

### Not done (and why)

- **Manual, by people** (acceptance 9 and 10): the pt-PT texts reviewed by a native speaker; the restore rehearsed on a clean machine (it was rehearsed here, on this one, into another database and folder); somebody who did not write the README standing up a two-instance Redis deployment from it alone; the security sign-off in `phases/security-review.md` (the checklist is filled in; the "Sign-off" table is empty).
- **The 24-hour soak** ran for 10 minutes here (`npm run soak -- --minutes=1440` is the full run).
- **The release itself**: tag, desktop installers published through `scripts/publish-desktop.mjs` to the real server, and the download page showing them; nothing was committed (the owner has not asked).
- The load numbers come from the development machine (one server process, MySQL in Docker on the same machine), not a "mid laptop" or a server; `NODE_ENV=development` for the harness (production refuses the local database's default password; nothing on the API's paths differs).
- A **third-party penetration test** (out of scope, recommended).

### Final run (2026-11-27)

| Suite | Result |
| --- | --- |
| server (`npx vitest run`) | 35 files, **711 / 711** |
| shared | 411 / 411 |
| build scripts | 29 / 29; themes 82 / 82; `node scripts/i18n-check.mjs` ok (1 677 keys) |
| web e2e (`npm run e2e`) | 96 tests: **95 pass** in the last full run; the one failure was `notifications.e2e` "B mutes the channel…" (the bell did not reach 1 within 20 s after a direct mention), which passed in the two runs before and when that file was run again on its own (4 / 4): a timing flake, not a regression, but it is on the list for the next person to look at |
| web e2e, real LiveKit (Docker) | 4 / 4 (found and fixed the blank voice page on a first visit) |
| desktop (`npm test -w @os-planner/desktop`) | 16 pass; the installer-release file is skipped (no 1.1.0 Windows build here) |
| load, full size | all budgets met |
| soak, 10 minutes | pass |

The first complete browser run failed five tests: the three new ones (accessibility found real problems: low-contrast leftovers "Coming soon", unnamed icon buttons and text boxes, an unnamed dialog; the journey test had a wrong expectation about a mute), one voice test (the blank page above) and the push test (it did not reproduce: it passed in every later run).

**nginx.** `nginx -t` (image `nginx:1.27-alpine`, both templates rendered with their variables and a throwaway certificate) passes, for the first time since the proxy was written; before it had only been read through. The `proxy` profile as a running stack (TLS in front of a live server) and `docker build` of the image have **not** been run in this phase.
