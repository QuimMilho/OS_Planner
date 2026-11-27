# Phase 15: Offline merge and local history

## Goal
Notebooks, boards, tasks, labels and the calendar can be viewed and edited offline. When the connection returns the changes merge with the online version field by field. When a field cannot be merged the **online version wins**, nothing is lost: the local change is kept in a **Local history** with a quick **Replace** (apply my version over the online one) or **Add as new** (create it as a new item) action.

**Depends on:** 10, 11, 12, 13 (the data it merges). Chat is not part of this phase (read cache + send queue exist from phase 7).

## In scope / Out of scope
- In: per-field versions, push with base versions, server three-way merge, rejected-change return, Local history store and UI (global and per entity), Replace / Add as new, delete-vs-edit handling, page content merge (CRDT from phase 11) with pre-merge snapshots, quotas during sync, e2e conflict scenarios.
- Out: manual diff/merge editor for text blocks (CRDT handles pages), history synced across devices (history is per device), undo of merges older than the retention window.

## Design
### Per-field versions
Each syncable entity (Board, Column, Task, Label, ChecklistItem, Event, EventException, Attendee state, Notebook, Category and page *metadata*) carries `fieldSeq JSON`: for each mutable field the space `seq` at which it last changed. The client remembers, per entity, the `baseSeq` it last saw.

### Push protocol
`POST /api/sync/batch` ops become `{ opId, entity, id, kind: create|update|move|delete, changes: {field: value}, base: {field: seqSeen}, clientTime }`.

The server handles each op in its own savepoint:
1. **Create**: idempotent by id; if the id exists (another device already pushed it) the op becomes a no-op success.
2. **Update**: for each changed field compare `fieldSeq[field]` with `base[field]`.
   - `fieldSeq <= base` → no concurrent change: apply.
   - concurrent change to the same field → **conflict**: keep the server value; return the field in `rejected` with the server's current value and `seq`.
   - disjoint fields merge cleanly (both sides' changes stay).
3. **Move/reorder**: position fields follow the same rule; a rejected position is re-derived locally from the server order.
4. **Delete**: if the entity changed on the server after `base` → rejected as `deleted_but_changed` (server copy stays); if the entity is already deleted → success.
5. **Edit of an entity deleted online** → rejected `target_deleted` (entity stays deleted; local data goes to history with an *Add as new* option).
6. Side effects on rejected ops are none (the savepoint rolls back that op only); accepted ops advance seq and emit events as usual.
- Permission and quota are re-checked per op at push time. An op the person may no longer perform is rejected with `forbidden` (never leaks existence); an op over quota is rejected with `quota_exceeded` and kept in the outbox for retry.

### Local history (client)
```
LocalHistory { id, at, device, entity, entityId, entityTitle, spaceId, spaceName, op, fieldsRejected: {field: {mine, server, serverSeq}}, snapshot (full local copy at push time), reason: conflict|target_deleted|forbidden|quota|pre_merge, resolved: none|replaced|added|dismissed, expiresAt }
```
- Written when the server returns `rejected` and, for pages, before an offline Yjs merge is applied (snapshot from phase 11).
- Kept 30 days (configurable, up to 90) and capped per device (5000 entries / 50 MB); oldest purged first; never auto-applied.

### Recovery actions
- **Replace** (field-level or whole entity): re-pushes the local values as a new op against the *current* server base, so it wins now (subject to permissions); it also records a history entry for the server value it overwrote so the action is itself reversible.
- **Add as new**: creates a new entity (new id) containing the local version in the same container (e.g. task → same column, "(my version)" suffix; event → same time; notebook page → copy of the page with the local content); for deleted targets, restores the item as a new one.
- **Dismiss** removes the entry.
- Replace is offered for entities that still exist ("already existing tasks"); Add as new is always offered.

## API
- Sync response extended: per op `{opId, status: applied|merged|rejected, rejected?: {...}, entity}`.
- `GET /api/sync/changes` unchanged apart from `fieldSeq` in rows.
- No server-side history store (history is local by design); the audit log (phase 4) records team-level changes.

## Web UI
- A **History** button in the header (badge = unresolved entries), also in each task/event/notebook menu ("Show my changes"). Panel: grouped by day/space, each entry shows what you changed, what's online now, and **Replace** / **Add as new** / **Dismiss** buttons, with field-level diff and a link to the live item. Bulk actions.
- After a sync with rejections: a non-blocking toast "N of your offline changes were not applied — see history".
- Editors show an offline indicator and a "pending changes" counter (outbox size); items with unsynced changes show a dot.
- Settings → Offline: retention, storage used by history, clear history, which spaces to keep offline (download scope) and a size warning.

## i18n keys
`history.*` (title, replace, addAsNew, dismiss, reasons: conflict/targetDeleted/forbidden/quota/preMerge), `offline.pending`, `offline.settings.*`, `sync.rejected`.

## Security & permissions
- Server never trusts `base`/`clientTime` for authorization; both only decide merge outcomes.
- History is local and may contain data the user later lost access to: on `revokedSpaces` the client purges that space's **history entries and snapshots** too (documented, tested).
- Replace re-checks permissions and quota; failing ones stay in history with the new reason.
- Op payloads validated with the same zod schemas as REST; unknown fields rejected.

## Quota impact
Merges that store bytes (task text, attachments, event text) charge the space at apply time. Oversized pending uploads stay queued (`quota_exceeded`, retryable). History is device-local (bounded by the settings above) and not charged to any quota.

## Implementation steps
1. Add `fieldSeq` to the syncable models (migration + backfill with the row `seq`), extend sync DTOs in `@os-planner/shared`.
2. Server merge engine as a pure module (`mergeOp(entity, op) → {apply, rejected}`) with exhaustive unit tests, then wire it to `SyncService`.
3. Client: outbox ops with `changes/base`, handling of per-op results, Dexie `localHistory`.
4. History UI + actions + settings.
5. Offline scope settings and cache eviction.
6. End-to-end conflict scenarios and docs.

## Acceptance criteria
1. [unit] `mergeOp` table tests: disjoint fields merge; same field concurrent → rejected with server value; unchanged-since-base applies; create idempotent; delete vs. edit and edit vs. delete; move conflicts; every outcome is deterministic regardless of op order within one batch.
2. [server] Sync batch: partial success (one op rejected, others applied) returns correct statuses; rejected ops change nothing (rows and seq); applied ops emit events once.
3. [server] Permission or quota changes between going offline and syncing → the affected ops are rejected with `forbidden`/`quota_exceeded` without leaking information; quota rejections are retryable.
4. [server] Concurrent pushes from two devices for the same entity produce a consistent final state and exactly one winner per conflicting field (property test with random op interleavings against the reference merge).
5. [web e2e] Two devices edit the same task offline (A: title + due date, B: title + priority); after both sync: due date and priority are both present, the title is B's/A's (whoever synced second is rejected → server value stays) and the loser's title is in their History.
6. [web e2e] **Replace**: from History on the losing device, Replace re-applies the title and the history entry resolves; the other device sees the new title live; the value that was overwritten is kept as a new reversible entry in the replacing device's History.
7. [web e2e] **Add as new**: a task edited offline but deleted online reappears as a new task "(my version)" in the same column; an event edited offline but cancelled online likewise.
8. [web e2e] Boards, calendar and notebooks: go offline with data cached, create, edit and delete across all three, reconnect, and verify server state and absence of duplicates (ids are idempotent).
9. [web e2e] Pages: two devices edit one page offline → merged text (no conflict copy), a `pre_merge` history entry exists with the local snapshot.
10. [web e2e] Losing access to a team while offline → on sync its cached data and its history entries are purged and the user is told.
11. [web e2e] Local history limits: retention expiry and the entry cap purge oldest first; clearing history in Settings works.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).

## Result

Done. Where the build differs from the plan above, and what later phases must know:

- **Merge rules** are one pure module, `packages/shared/src/dto/merge.ts` (in the main *and* the `lite` entry, no dependencies, so the server and the web run the same code): `mergeUpdate` (per field: applied / merged / rejected / `target_deleted`),
  `mergeDelete` (`apply` / `already` / `deleted_but_changed`), `baseOf`, `nextFieldSeq`, `patchFromFields`. Differences from the plan: the **merge fields are groups** where the values must stay consistent — a task's `dates` (start, due, all day),
  `place` (column, position, board; a move is one field), an event's `timing` (start, end, all day, zone, repeat rule) — and a task's `completed`; the plan listed them as single fields. `fieldSeq` is a sparse JSON (`NULL` = nothing changed since it was
  made = every field at 0), so the migration (`field_seq`: `Notebook`, `Category`, `Page`, `Task`, `Event`) needs no backfill and is forward-only. Boards, columns, labels, `ChecklistItem` (it travels inside the task's `checklist` field),
  `EventException` and attendee answers are **not** merged field by field (no offline ops exist for the first three; occurrence changes and RSVPs keep "later request wins"; see the README "Known limitations").
- **Where the decision is taken.** `apps/server/src/common/merge-scope.ts`: `SyncService.batch` runs each op inside an `AsyncLocalStorage` scope (`base` of the op, what this push already wrote, the result). The services call `guardUpdate`/`guardDelete`
  **inside their own write transaction, after taking the space lock** (`ChangeSeqService.next`), so deciding and writing cannot be separated by another writer (a test pushes two batches at once). Outside a scope (REST, collaboration) the guards allow everything
  and only keep `fieldSeq` up to date, so *every* change path that writes a tracked field must go through them — **a new writer of `title`/`name`/… on these five tables must call the guard (or bump `fieldSeq`) or later offline pushes will not notice it**.
  A change of which nothing may be applied throws `MergeRejected`, the transaction rolls back (rows *and* the `Space.changeSeq` counter are as before), and the result is `ok:false` with `conflict`, `target_deleted` or `deleted_but_changed`
  (+ `rejected` = per field `{mine, server, serverSeq}` and `entity` = the row as it is online). Some fields applied: `ok:true, status:'merged'`. Ops of one push never conflict with each other (`own`), and the client rebases the ops still queued
  after each answer (`Sync.rebase`). An update that finds the entity deleted or purged, or not visible, answers `target_deleted` for ops that carry `base` (the same answer for all three: nothing leaks); old clients (no `base`) get the old answers.
- **Delete vs edit** looks at the entity's own fields only: a notebook deleted offline does not check pages edited in it online. A recurring event's `this`/`following` scopes are not merged (they only check the event exists).
- **Client.** `Outbox.enqueue` adds `base` (from the cached row's `fieldSeq`) to every update, move, delete and cancel — stores did not change — and keeps the *first* base of a folded burst. `Sync.pushOperations` handles the answers: merged / refused
  ops are written to the Local history (`HistoryStore.record`), the local copy is refreshed from the answer's `entity` (events and tasks are read again), a refused delete or an edit of something gone is undone locally, and one toast per push tells how many
  changes were not applied (`sync.rejected`, with a link to the history). Dexie v9: `localHistory` has the full shape of the plan (`at, device, entity, entityId, entityTitle, spaceId, op, fieldsRejected, patch, snapshot, reason, resolved, expiresAt, bytes`)
  and the phase 11 rows were upgraded to it; the pre-merge copy of a page (`pageId`, `state`) is an entry of reason `pre_merge`.
- **History screen** `/app/history` (`features/history/history-page.ts`), the header button (badge = entries that need a decision; the page copies kept before a merge are listed but do not count, they are a safety net and exist after *every* offline edit of
  a page), *Show my changes* in the task, page and event menus (`?entity=<id>`). Replace = the store's own update (task, event, notebook, category, page title/place, or the delete again) with a fresh base, plus an entry for what it overwrote;
  for a page copy it is `POST /api/pages/:id/snapshots/replace` (EDIT_PAGES; saves the page first). Add as new: task (same column, `(my version)`, checklist items get new ids), event, notebook, category, page (with the text kept). Bulk actions act on what is shown.
  **Settings → Offline** (`features/history/offline-settings.ts`): days (1–90), entries and size used, clear, which spaces keep page *texts* on the device (`OfflineScope`: notebooks, boards and the calendar are always kept; a space left out is fetched on open),
  and the browser's storage estimate with a warning. Retention (`expiresAt`), 5000 entries and 50 MB are enforced by `HistoryStore.purge` after every sync cycle and every new entry; a lost space purges its entries and tells the person (`sync.spaceRevoked`).
- **The initial bundle** went over the 2.2 MB limit with this phase's texts, so the **Portuguese texts are now a lazy chunk** (`InlineTranslationLoader`, preloaded by an app initializer for the active language; the service worker prefetches every chunk):
  2.15 MB of 2.2 MB. (The plan had this for phase 17.)
- **Not done:** an offline copy of *followed* calendars (they are fetched by the server and still show only online); a manual diff of text blocks (out of scope); the per-device "which spaces to keep" does not delete what is already stored for a space that is left out
  (it only stops downloading page texts). Acceptance 8 (create/edit/delete across boards, calendar and notebooks offline) is one e2e covering create and edit in all three and a delete of a task is covered by the server tests, not by the browser.
- **Tests.** shared +22 (`dto/merge.test.ts`), server +21 (`sync-merge.test.ts`) +1 (migration), web e2e +6 (`offline-merge.e2e.mjs`) and an assertion in `collab.e2e.mjs`.
