# Phase 3: Spaces, teams and the hierarchy core

## Goal
Add the Team → Project → Sub-project hierarchy and the Space model that gives every container its own notebooks, sync cursor and quota, plus the permission engine every later phase relies on. After this phase a team exists, has members and projects, and people see only what they may.

**Depends on:** 2. **Needed by:** 4, 5, 6, 10.

## In scope / Out of scope
- In: Space migration, teams, projects (any depth), memberships, owner/admin creation flow, permission engine + guards, team rail, project tree, breadcrumbs, team/project notebooks listed (content features arrive with phase 10).
- Out: roles beyond `@everyone` + a default "Member" (phase 4), invites (5), chat (7).

## Data model
```
Space        { id, kind: personal|team|project, userId?, teamId?, projectId?, changeSeq, storageUsedBytes, createdAt }
Team         { id, name, slug, icon, color, description, ownerId, isPublic, joinPolicy: open|request, spaceId, createdAt, deletedAt }
Project      { id, teamId, parentId?, name, description, icon, color, position, spaceId, archivedAt?, createdAt, deletedAt }
TeamMember   { teamId, userId, nickname?, joinedAt }                    PK (teamId, userId)
ProjectMember{ projectId, userId, joinedAt }                            PK; userId must be in the parent (project or team)
PendingOwner { id, teamId, email, createdAt }                           ownership applied when that email registers (phase 5 sends the mail)
```
- `Notebook`, `Category`, `Page`, `Media` gain `spaceId`; `Notebook.userId` stays as *creator*. Migration: create one personal Space per user, set `spaceId` on all existing rows, move `User.changeSeq` and `storageUsedBytes` to the Space, keep `User.changeSeq` readable until clients update (dual-write for one release).
- Project tree stored as adjacency list (`parentId`) with a materialised `path` (`/teamId/…/projectId/`, indexed) for ancestor/descendant queries and the permission chain.
- Seq: `ChangeSeqService.next(tx, spaceId)`.
- Roles: a `Role` table arrives in phase 4. Here every member has the implicit **@everyone** permission set stored on `Team.everyonePermissions BIGINT UNSIGNED` (default: view + read + send + view notebooks/boards/calendar), and the owner has all permissions.

## Permission engine (`packages/shared/src/permissions/`)
- `Permission` as a `bigint` bit map exactly as in [overview §2.3](overview.md#23-permission-engine-packagessharedsrcpermissions), `has`, `all`, `none`, `toString/fromString`.
- `computePermissions({ member, team, chain: ProjectLevel[], channel? })`, pure and total. Tests are exhaustive over a generated matrix (see criteria).
- Server: `PermissionService.resolve(userId, context)` loads team, roles, overwrites for the chain in one query set (cached per request); `@RequirePermission(Permission.X)` guard resolves the context from route params; insufficient permission on something the caller can view → 403; no `VIEW` → 404.
- Web: `PermissionStore` (signals) fed by `GET /api/teams/:id/me` (member's resolved base + per-project/channel results), used to show/hide controls. The server stays authoritative.

## API
- Admin: `POST /api/admin/teams {name, ownerEmail, isPublic?, joinPolicy?}` → creates team + team space; owner = existing user, or `PendingOwner` when the email has no account yet (the invite mail is phase 5). `GET /api/admin/teams`, `DELETE /api/admin/teams/:id` (soft delete, 30 days).
- Teams: `GET /api/teams` (mine), `GET/PATCH /api/teams/:id`, `GET /api/teams/:id/members`, `GET /api/teams/:id/me`.
- Projects: `GET/POST /api/teams/:id/projects` (tree), `GET/PATCH/DELETE /api/projects/:id`, `POST /api/projects/:id/move {parentId}` (cycle check; same team), `GET/POST/DELETE /api/projects/:id/members`.
- `GET /api/sync/changes?cursors=…` replaces the single cursor (old `since` still accepted for one release); response adds `revokedSpaces`.
- Notebooks in a team/project space: `GET /api/spaces/:id/notebooks` and the existing notebook/category/page endpoints accept spaces the caller may view.

## Web UI
- **Left rail** (Discord-like): DM/home button, the person's team icons (colour or letter), unread badge slot (filled in phase 9), "Browse public teams" (phase 5). The personal area is "Home".
- **Team view**: sidebar with the project tree (collapsible, drag to reorder/move), sections *Notebooks*, *Boards*, *Channels* (placeholders until their phases), member list.
- **Breadcrumb** `Team / Project / Sub-project` in the header of every page; each crumb links to that level.
- **Admin → Teams**: create a team and name its owner by email.
- Routes: `/app/t/:teamId`, `/app/t/:teamId/p/:projectId`, existing `/app/n/…` and `/app/p/…` keep working for personal notebooks.
- Offline: team/project metadata cached in Dexie (`teams`, `projects`, `members`), per-space cursors in `meta`.

## i18n keys
`rail.home`, `team.*` (name, members, settings, create, owner), `project.*` (new, subproject, move, archive), `breadcrumb.*`, `admin.teams.*`, `errors.forbidden`, `errors.notFound`.

## Security & permissions
- 404 for anything the caller cannot view (team, project, member list of a team they are not in).
- Moving a project: caller needs `MANAGE_PROJECTS` in both the old and the new parent; cycle and cross-team moves refused.
- Removing a member from a parent also removes them from every descendant project.
- Soft-deleted teams disappear from every list immediately and revoke their spaces in sync (`revokedSpaces`).

## Quota impact
- Team creation checks `MAX_PROJECTS_PER_TEAM` on project creation; storage charges go to the Space of the content. Project usage also increments the team total (two-level charge, one transaction).
- Personal quota keeps applying to the personal Space only.

## Implementation steps
1. Shared: permission bits, `computePermissions`, exhaustive tests.
2. Prisma models + migration with data-preserving backfill; dual-write cursor.
3. `SpacesModule`, `TeamsModule`, `ProjectsModule`, `PermissionService`, guards.
4. Sync by space; `revokedSpaces`; update `SyncService` on the web (per-space cursors).
5. Admin team creation + `PendingOwner`.
6. Web: rail, team view, breadcrumbs, admin page, Dexie tables.
7. Update README (hierarchy) and `.env.example`.

## Acceptance criteria
1. [unit] Permission engine: owner and `ADMINISTRATOR` get everything; `@everyone` base applies; role union; overwrite order (everyone deny/allow → role deny/allow → member deny/allow) at each level; a deeper allow beats a shallower deny; a member allow beats a role deny at the same level; no `VIEW_CHANNEL` removes dependent permissions; property test over random role/overwrite sets matches a straightforward reference implementation (≥ 10 000 cases).
2. [server] Migration test: start from a database with users, notebooks, pages and media created by the previous schema; after migrating, every row has a personal `spaceId`, sync returns identical data, usage counters equal the old totals.
3. [server] Admin creates a team with an existing owner → owner is a member with all permissions; with an unknown email → `PendingOwner` row and no member until that email registers, then ownership applies on first login.
4. [server] For every team/project endpoint: member allowed, member lacking permission 403, non-member 404 (table-driven test).
5. [server] A sub-project cannot gain a member who is not in its parent; removing a team member removes them from all descendants; moving a project into its own descendant is rejected.
6. [server] Sync: two spaces advance independently; a user removed from a team gets it in `revokedSpaces` once; concurrent writes in one space produce gap-free ordered seq; writes in different spaces do not block each other.
7. [web e2e] Admin creates a team naming user B as owner; B sees the team in the rail and the (empty) team view; user C sees nothing and gets the 404 page for the URL.
8. [web e2e] Create a project and a sub-project, move it, and watch the breadcrumb and tree update; a second member sees the same tree without reload (after phase 6) or on next sync (this phase).
9. [web e2e] Existing personal notebooks, search, trash, export and offline editing behave exactly as before (every earlier scenario stays green, once the open item recorded in [phase 0](phase-0.md#result) is fixed).
10. [web e2e] Offline: team/project tree and notebook list load from Dexie; a team removed on the server disappears locally on the next sync.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases). The dual-write of `User.changeSeq` is removed in phase 17.
