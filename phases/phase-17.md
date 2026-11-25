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
