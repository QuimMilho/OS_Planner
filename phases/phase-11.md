# Phase 11: Real-time co-editing

## Goal
Everyone editing a page sees each other's changes live, with cursors and names, with offline edits merging automatically. One editor path serves private pages, team/project pages and shared pages. Search, PDF export and Markdown export keep working because the TipTap JSON stays the canonical *published* format.

**Depends on:** 10 (access rules), 6 (transport conventions). **Needed by:** 15. **Prerequisite:** fix the open equation-insertion editor test from [phase 0](phase-0.md#result) first (this phase rewrites the editor binding).

## In scope / Out of scope
- In: Yjs documents per page, Hocuspocus server on `/api/collab`, TipTap Collaboration + CollaborationCaret, permission-checked auth, persistence in MySQL, derived JSON/text, one-time migration of existing pages, offline persistence (`y-indexeddb`), presence cursors, read-only enforcement, snapshots for local history, Redis scaling.
- Out: comments/suggestions, version history UI beyond snapshots (listed as a later item), co-editing of titles beyond last-write-wins with a live update, collaborative whiteboards.

## Design
- **Documents**: each `Page` has a Yjs document (fragment `content` mapped to the TipTap schema, map `meta` for the title). The document is the source of truth while a page is open or has pending updates; `Page.content` (JSON), `contentText`, `version` and `seq` are **derived** from it.
- **Server** (`CollabModule` using Hocuspocus):
  - `onAuthenticate`: access JWT (or link-scoped JWT from phase 10) → resolves `read | edit | none` for the page via `PermissionService` / share rules; `read` connections are `readOnly`; none → refused with no information.
  - `onLoadDocument`: loads `PageYDoc.state` (binary); if absent, builds a Y-doc from the page's JSON (`prosemirrorJSONToYDoc`) — this is the lazy **migration** path, also run by a one-time batch job.
  - `onStoreDocument` (debounced 2 s, max 10 s; on last disconnect): writes the Y-state, derives JSON with the shared schema (`validateDoc`), updates `content`, `contentText`, `sizeBytes` (quota charge in the same transaction), bumps `version` and the space `seq`, publishes `page.updated` on the event bus (sync + search stay current).
  - Invalid or oversized documents (over `docMaxBytes`) are refused at store time and the connection is told; the previous good state stays.
  - Snapshots: `PageYSnapshot { pageId, createdAt, state, byUserId?, reason }` taken when a session ends, hourly while active, and before an offline merge is applied; capped (last 50 + one per day for 30 days). Used by phase 15 for local history and by moderators to recover a page.
  - Redis extension when `REDIS_URL` is set; otherwise single instance.
- **Client**:
  - The editor component replaces its Dexie/JSON binding by a `Y.Doc` with `y-indexeddb` (per page) + `HocuspocusProvider` (`apiBase() || location.origin`).
  - `EditorPage` keeps the existing toolbar, node views, slash menu, outline, autosave indicator (now "synced / offline changes pending"), conflict-copy flow **removed** for co-edited pages.
  - Offline: edits go into the local Y-doc; on reconnect the provider syncs and CRDT merge resolves them. Before applying a remote state over diverged local edits, a **local snapshot** is stored (`LocalHistory`, phase 15).
  - Cursors/selections with name and colour from the user (colour from a stable hash; respects the theme).
  - The sidebar and search still read page *metadata and JSON* from the sync layer (derived values), so nothing else changes.
  - Outbox/version checks for page content stop being used; metadata (rename, move, delete) still use the outbox.
- **Compatibility**: clients older than this phase keep using `PUT /api/pages/:id/content`; the server accepts it by converting to a Yjs update **only while no Hocuspocus session is open** and answers `409 collab_active` otherwise (the client reloads). The endpoint is removed in phase 17.

## Data model
```
PageYDoc      { pageId PK, state LONGBLOB, stateVector BLOB, updatedAt }
PageYSnapshot { id, pageId, state LONGBLOB, byUserId?, reason: session_end|hourly|pre_merge|manual, createdAt }
```
`Page.content` stays (derived) so existing queries, FULLTEXT search, exports and sync of read-only clients continue to work.

## Web UI
- Presence avatars in the page header; coloured carets with names; "N people editing".
- Read-only banner for `read` access; the toolbar disabled.
- Connection badge in the editor: *Live · Offline (changes saved on this device) · Reconnecting*.
- Title edited live; page rename in the tree updates for everyone.
- "Restore a previous version" (moderators/owner) lists snapshots with preview and restore (restore = a new update, not a rollback of history).

## i18n keys
`collab.live|offline|reconnecting|editing`, `collab.readOnly`, `collab.snapshots.*`, `editor.pendingOffline`.

## Security & permissions
- Same access function as REST; checked on connect and re-checked every time permissions change (the server closes affected connections on `permissions.changed`, link revocation or share removal).
- Read-only connections cannot send updates (server drops them, not only the client UI).
- Document size, update rate and number of connections per page/user are limited.
- Awareness data limited to name, colour and cursor; no emails.
- Anonymous read via share link uses the plain HTTP reader, not the collab socket.

## Quota impact
The server charges the owning space on every store using the derived `sizeBytes` delta; a store that would exceed the quota is refused, the document stays editable in memory for the session and the user is told to free space (the text is kept in `y-indexeddb` on their device). Y-state size is overhead of the system and is not charged; it is compacted (`Y.encodeStateAsUpdate` garbage collection) on store, and `PageYDoc` growth is monitored in the admin stats.

## Implementation steps
1. Fix the equation-insertion regression; add the scenario as a protected e2e.
2. Shared: confirm the schema converts both ways (`prosemirrorJSONToYDoc` / `yDocToProsemirrorJSON`) for every custom node (unit round-trip fixtures).
3. `CollabModule`: auth, load, store, derive, snapshots, quota, Redis.
4. Batch migration job + lazy path; compatibility `409 collab_active`.
5. Client: provider, `y-indexeddb`, extensions, awareness, status UI.
6. Read-only/permission change handling; snapshots UI.
7. Docs and `docker-compose` (nothing new unless Redis).

## Acceptance criteria
1. [unit] JSON → Y-doc → JSON round-trips every fixture in `packages/shared/src/doc/fixtures.ts` (all node types: tables, math, mermaid, chart, plot, images, video, callouts) without loss.
2. [server] Two clients on one page converge to identical documents after concurrent edits (property test with random operations, N ≥ 200 runs).
3. [server] A `read` user's updates are dropped; an `edit` user's are stored; no access → refused identically to a missing page.
4. [server] Revoking a share/link or removing a member closes their open collab connection within 5 s.
5. [server] Store derives `content`/`contentText` valid against the schema, updates `version`, `seq` and `sizeBytes`; search finds new text; the PDF/Markdown export of the page includes edits made through collab.
6. [server] An update that would exceed quota or `docMaxBytes` is refused without corrupting the stored state; the previous state loads.
7. [server] Existing pages migrate lazily and via the batch job; the old `PUT …/content` works only while no session is open, otherwise `409 collab_active`.
8. [server] Snapshots: created on session end, hourly and before merges; pruning keeps the documented set; restore creates a new update and a `pre_merge`-style snapshot first.
9. [web e2e] Two users in one page: typing, formatting, inserting a table and a chart appear live for both with named cursors; a third user with read access sees but cannot type.
10. [web e2e] Offline: both edit the same paragraph offline, then reconnect → merged text contains both edits, no conflict copy is created, a local snapshot exists.
11. [web e2e] A private page (single user) works exactly as before (all earlier editor scenarios pass unchanged), including reload, offline reload and PDF export.
12. [web e2e] Share-link edit session: link user edits live with the owner; revoking the link stops their edits and shows the read-only state.
13. [manual] Cursor colours legible in all themes; behaviour with 5 simultaneous editors on a 50-page notebook.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).

## Result

Done. Where the build differs from the plan above, and what later phases must know:

- **One module: `apps/server/src/collab/`.** `CollabServer` owns Hocuspocus (v4) behind a plain `ws` server on the API's HTTP server, path `/api/collab` (decided synchronously in the `upgrade`
  handler: engine.io closes upgrades nobody answered within a second; same origin rule as the Socket.IO server; 2 MB per message; the server pings every 25 s). `CollabService` is the
  Hocuspocus extension (auth, load, store, snapshots, limits). `CollabRegistry` is what the rest of the API sees (`isOpen(pageId)`, `change(pageId, fn)` = a change applied through a
  direct connection, so people in the page see it). `SnapshotsService`/`SnapshotsController` serve `GET /api/pages/:id/snapshots`, `GET …/:snapshotId` (preview) and `POST …/:snapshotId/restore`.
- **Shared** gets a third entry, `@os-planner/shared/collab` (Yjs ↔ TipTap JSON: `jsonToYDoc`, `yDocToJSON`, `applyJSON` = a diff applied as a normal update, `canonicalJSON`, `docFromState`) so the
  web app's first-load bundle never sees Yjs (the editor chunk carries it; initial total unchanged at 2.12 MB). Constants, limits and DTOs (`COLLAB_*`, `PageSnapshotDto`, `CollabStatsDto`) are in
  `dto/collab-consts.ts` (main and lite entries); `isBlankDoc` is in `doc/empty.ts`.
- **Access = the same function as REST.** `onAuthenticate` verifies the access JWT (media and link tokens are refused), that the login behind it is alive, and `PermissionService.notebookAccess`
  for the page's notebook; `EDIT_PAGES` (and a page and notebook that are not in the trash) decides `readOnly`. A page that does not exist, a notebook the person cannot see and a bad token
  are refused with the same `forbidden`. Read-only connections cannot write: Hocuspocus drops their updates on the server. A share edit link needs no special case: joining turns it into an
  edit share (phase 10), so it is `notebookAccess` like any other; anonymous visitors never use the socket.
- **Closing connections.** `CollabServer.recheck()` runs on `permissions.changed`, `membership.changed`, `session.revoked`, `team.audited` (it is awaited inside the publisher, so a revoked share or a
  removed member is disconnected before the request that did it answers) and every `COLLAB_RECHECK_MS` (20 s: the backstop for what has no event, e.g. a page put in the trash). A connection that
  lost access is closed with 4403; one whose right to type changed is closed with 4205 and the client reconnects with the new scope. The provider reconnects after any close.
- **Storage.** `PageYDoc` (state + vector) is the source of truth while a page has one; `Page.content`, `contentText`, `sizeBytes`, `version`, `seq` and `PageMedia` are derived in one transaction
  per store (debounce `COLLAB_DEBOUNCE_MS` 2 s, max 10 s, and when the last person leaves), the quota is charged by the `sizeBytes` delta, and `page.updated` is published. Refusals (invalid
  document, over `docMaxBytes`, quota) leave the stored state alone, are counted, and are announced to the page with a stateless `{t:'refused', reason}`. A store never *throws* on a refusal
  (Hocuspocus keeps a document in memory forever after an exception). A picture or video whose file has not reached the server yet is **not** a reason to refuse: the page is stored with the
  reference and the link in `PageMedia` is made by a later store (the server stores again every 10 s, up to 12 times, while the page is open). *Known gap:* if the tab closes before the upload
  finishes, the link is made at the next store of that page.
- **Lazy migration and the batch.** A page without a `PageYDoc` is built from its JSON when first opened; the build is deterministic (fixed client id; a blank page is built as an empty fragment) so
  two instances racing produce the same bytes. `COLLAB_MIGRATE_ON_START` (default on) builds the rest in the background, 100 pages at a time. Nothing in the client ever builds from JSON.
- **Compatibility.** `PUT /api/pages/:id/content` answers `409 collab_active` while the page is open on *this instance* (with Redis the other instances are not asked), and otherwise applies the
  document to the stored Yjs state as a diff in the same transaction, so a device holding an older copy still merges instead of duplicating text. The web `Sync` treats `collab_active` as "try later".
- **Snapshots.** `session_end` is taken when a page unloads after somebody changed it (not for a session in which nothing changed), `hourly` while it stays open, `pre_merge` before a restore.
  Pruning keeps the newest 50 plus the newest of each of the last 30 days. Restore = `applyJSON` through a direct connection (a new update, broadcast to the open page) after a `pre_merge`
  snapshot. Seeing and restoring needs `MANAGE_NOTEBOOKS` (everything in one's own notebook; an edit share cannot). **Deviation:** the *client* decides what a "merge" is: when a device that had
  changes made while disconnected authenticates, it keeps a copy of its document in Dexie `localHistory` (last 20 per page; the table phase 15 builds on) before the server's state arrives. The
  server does not snapshot on every non-empty SyncStep2.
- **Awareness** is rewritten by the server (`beforeHandleAwareness`): only `user {name, color}` and `cursor`; the name comes from the account and the colour from the person's id (a six-digit hex
  colour: the cursor code of the editor rejects anything else). Limits: 6 connections per person and page, 60 per page, 60 messages/s per connection (burst 120); a document that grows past
  4 × `docMaxBytes` in memory is cut off.
- **Redis.** With `REDIS_URL` the `@hocuspocus/extension-redis` extension shares each page between instances (and its store lock keeps one instance writing). Tested with two Nest instances on one
  Redis (`collab-redis.test.ts`, needs `docker compose --profile scale up -d redis`).
- **Web.** `features/editor/collab-session.ts` (one per open page: `Y.Doc` + `y-indexeddb` per person and page + `HocuspocusProvider`, signals for status/scope/peers/refusal) and the rewritten
  `EditorPage`: the editor is bound to the document with TipTap `Collaboration` + `CollaborationCaret` (undo is the person's own); the title still goes through the outbox (other devices see a
  rename through the existing sync). **A page never opened on this device is shown read-only from its saved copy until the server's version arrives** (building it locally would duplicate it
  on merge); a page just made here, and any blank page while offline, is editable at once. The Dexie `contents` row is now a clean cache (`PageStore.cacheContent`, `dirty` 0, never queued) for
  search, export and the preview; the old autosave/draft/`watchRemote`/conflict-copy path is gone for open pages (`Sync` still pushes dirty rows written by an older version of the app). Header:
  connection badge (`data-conn` live | reconnecting | connecting | offline), "N people editing" with initials, read-only and refusal banners, page menu → *Earlier versions…* (`SnapshotsDialog`).
  `export()`, `saveNow()` and trashing first ask the server to store now (stateless `flush`, answered `stored`), so exports see the last keystroke.
- **Gotchas found on the way.** (1) An exception thrown by a `HocuspocusProvider` callback during construction (`onStatus` runs before `this.provider` exists) makes the library's connect loop
  retry a second connection 1 s later and drop the first: guard callbacks that touch the provider. (2) y-tiptap only accepts `#rrggbb` colours; TipTap's caret classes are
  `collaboration-carets__*` (plural). (3) Playwright's `setOffline` fires no `online`/`offline` events: the session polls `navigator.onLine` every 2 s. (4) Several clients authenticating at the same
  moment all see "0 connections": the per-person limit is enforced again in `connected`, keeping the first ones. (5) Hocuspocus' `Connection.close()` only sends a close *message*; to drop a
  connection close its `webSocket`. (6) A test that floods updates from one connection hits the rate limit: pace it. (7) `waitForFunction` with a string is `eval` and the CSP blocks it.
- **nginx / README / env.** The template already routed `/api/(realtime|collab)` with upgrades and a 1 h read timeout; its comment now says co-editing is live (WebSocket only, no polling fallback, the
  server pings). README has a "Co-editing" section; `.env.example` and `docker-compose.yml` gained `COLLAB_DEBOUNCE_MS`, `COLLAB_MAX_DEBOUNCE_MS`, `COLLAB_RECHECK_MS`, `COLLAB_MIGRATE_ON_START`.
  `GET /api/admin/collab` shows open pages and connections, stores, refusals and the weight of the live documents and snapshots.
- **Offline detail worth knowing.** Without a network a socket cannot finish its closing handshake, so the browser keeps calling it open and the library keeps thinking it is connected and ignores
  `connect()` (the first version of the e2e was flaky for exactly this). `CollabSession.dropSocket()` runs the library's own "socket closed" path by hand when the browser goes offline and
  before every reconnect, and the badge trusts `navigator.onLine` before the socket.
- **Tests.** Shared +9 (round trip of every node type, determinism, `applyJSON`, blank seed, colours, 250 random concurrent edits); server +25 (`collab.test.ts` 23: convergence over 250 rounds, access
  matrix, revocation within 5 s, derived values, refusals, lazy/batch migration, compat PUT, snapshots, limits; `collab-redis.test.ts` 1 with two instances on Redis; migration test 1); web e2e +3
  (`collab.e2e.mjs`: two editors + a reader, offline merge with a local snapshot, edit-link session and revocation) and one removed (the conflict-copy scenario). Existing e2e needed three
  changes: the harness sets a short store debounce, the shared-notebook test waits for the editor to become editable (first open of a page on a device is read-only until the server's version
  arrives), and the conflict-copy test is gone.
- **Not done / for later.** Comments and suggestions, a full version-history UI, collaborative whiteboards (out of scope); removing a refused upload's node from open documents; the `409 collab_active`
  check across instances; the `PUT …/content` endpoint goes in phase 17. The criterion-13 manual checks (colours in every theme, five editors on a 50-page notebook) were not run.
