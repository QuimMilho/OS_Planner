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
