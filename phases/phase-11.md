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
