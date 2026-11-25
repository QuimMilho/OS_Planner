# Phase 2: Admin and quotas foundation

## Goal
Introduce instance administrators and one place where storage limits are decided, so later phases only call `QuotaService`. Personal storage is limited per user; team and project limits exist from the start and can be upgraded later (plans, billing) without touching callers.

**Depends on:** 0. **Needed by:** 3 (team creation), 5 (member limits), 7, 10, 12.

## In scope / Out of scope
- In: `ADMIN_EMAILS`, admin guard, `/admin` pages (users, quota overrides, teams placeholder), `QuotaPolicy`/`QuotaService`, usage accounting for existing media and documents, usage UI, `413 quota_exceeded`.
- Out: billing, plans UI, payment providers, per-member sub-quotas inside a team. The interface leaves room for them.

## Data model
- `User`: keep `storageUsedBytes`. New table `QuotaOverride { id, scope: user|team|project, scopeId CHAR(36), storageBytes BIGINT NULL, maxMembers INT NULL, maxProjects INT NULL, maxFileBytes BIGINT NULL, note, updatedBy, updatedAt }`, unique on `(scope, scopeId)`. NULL means "use the default".
- Usage is stored where the bytes live: `User.storageUsedBytes` now; `Space.storageUsedBytes` after phase 3 (phase 3 migrates the counter).
- Document bytes: `Page` gains `sizeBytes INT` (UTF-8 size of the JSON), maintained on content writes, so text counts toward the quota (media remains in `Media.size`). Backfilled by the migration.

## Configuration
`ADMIN_EMAILS` (comma list, case-insensitive), `USER_QUOTA_MB` (existing, default 2048), `TEAM_QUOTA_MB` (default 10240), `PROJECT_QUOTA_MB` (default 0 = limited only by the team), `MAX_MEMBERS_PER_TEAM` (default 100), `MAX_PROJECTS_PER_TEAM` (default 50). All in `.env.example` and compose.

## API
- `GET /api/me` adds `isAdmin` and `quota: { scope:'user', used, limit }`.
- Admin (guard `AdminGuard`: verified email AND in `ADMIN_EMAILS`; anyone else gets 404):
  - `GET /api/admin/users?q=&cursor=` (email, name, usage, limit, created, verified)
  - `GET/PUT/DELETE /api/admin/quotas/:scope/:id` (read effective + override, set, clear)
  - `GET /api/admin/stats` (users, storage, teams)
- `QuotaService` (internal):
  - `limitFor(scope, id)`: override → `QuotaPolicy.defaults(scope)` → env.
  - `usage(scope, id)`
  - `assertCanStore(scope, id, bytes)` throws `QuotaExceeded` → `413 {code:'quota_exceeded', scope, limit, used, requested}`
  - `charge(tx, scope, id, delta)` inside the writing transaction (atomic compare-and-add: `UPDATE … SET used = used + ? WHERE id = ? AND used + ? <= ?`).
  - `interface QuotaPolicy { defaults(scope): Limits }` with `EnvQuotaPolicy` as the default binding (the seam for plans).
- Media upload, content writes and exports go through `QuotaService`; existing behaviour for users is preserved (same numbers, new error shape).

## Web UI
- Settings → Storage: usage bar (used / limit, per-type breakdown: images, video, documents), warning at 80 %, blocking message at 100 %.
- `/admin` (lazy, only for `isAdmin`): Users table with search and inline quota override editor; stats cards. Hidden from non-admins; route guard + 404 page.
- Upload UI shows the quota message instead of a generic failure; queued uploads stay on the device and retry after space is freed.

## i18n keys
`quota.title`, `quota.used`, `quota.limit`, `quota.images`, `quota.video`, `quota.documents`, `quota.warning`, `quota.full`, `admin.title`, `admin.users`, `admin.override`, `admin.clear`, `admin.stats`, `errors.quotaExceeded`.

## Security & permissions
- Admin endpoints answer 404 to non-admins (no hint they exist). `ADMIN_EMAILS` requires a *verified* email to count, so registering an admin's address does not grant access.
- Every override change is written to a server log now and to the audit log in phase 4.
- Overrides cannot be negative; limits are capped at 2⁵³ − 1 to keep JSON numbers exact (bytes are sent as strings above that).

## Quota impact
This phase *is* the quota layer. Rules fixed here for later phases: charge on the owning scope; an operation that stores bytes is refused entirely if it does not fit; deletions refund on hard delete (trash purge), not on soft delete; a project's usage is also added to its team's total.

## Implementation steps
1. Env parsing and `isAdmin(email)`; `AdminGuard`.
2. `QuotaOverride` + `Page.sizeBytes` migration with backfill.
3. `QuotaService`, `EnvQuotaPolicy`; replace the ad-hoc checks in `media.service.ts` and page writes.
4. Admin endpoints; stats queries.
5. Web: usage bar, admin area, error handling.
6. Docs and env files.

## Acceptance criteria
1. [server] Non-admins, unverified admins and anonymous callers get 404 on every `/api/admin/*` route; a verified admin gets 200. (`admin.test.ts`)
2. [server] `limitFor` order: override beats env default; clearing an override restores the default.
3. [server] An upload that exceeds the remaining quota returns 413 with `scope`, `limit`, `used`, `requested`; nothing is stored (file and rows absent); the counter is unchanged.
4. [server] Two concurrent uploads that together exceed the quota: exactly one succeeds (atomic charge).
5. [server] Document writes count toward usage; trash purge refunds; soft delete does not.
6. [server] Migration backfill: usage equals the sum of existing `Media.size` and `Page.sizeBytes` for a database created before this phase.
7. [unit] A custom `QuotaPolicy` can replace `EnvQuotaPolicy` (provider override in a test) and the new defaults apply.
8. [web e2e] The usage bar reflects an upload; at the limit the upload shows the quota message and the document still saves text.
9. [web e2e] An admin raises another user's override in `/admin` and that user's limit changes without logging out; a non-admin visiting `/admin` sees the 404 page.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).
