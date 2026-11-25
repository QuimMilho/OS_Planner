# Phase 4: Roles, overwrites and audit log

## Goal
Discord-style permission management: team roles, project roles, allow/deny overwrites on projects and channels, with the same selection UI Discord uses, and an audit log of every sensitive change.

**Depends on:** 3. **Needed by:** 5, 7, 9, 10, 12, 13, 16.

## In scope / Out of scope
- In: `Role`, role assignment, `@everyone` editing, project roles, overwrites (role and member) on projects now and on channels/boards/notebooks when those exist, hierarchy rules, tri-state editor, "view as" simulator, `AuditLog` + viewer.
- Out: role templates marketplace, per-permission descriptions beyond a tooltip, custom badges.

## Data model
```
Role            { id, teamId, projectId?, name, color, position, permissions BIGINT UNSIGNED, hoist, mentionable, isEveryone, createdAt }
                  projectId NULL = team role; non-NULL = project role (applies only inside that project and its descendants)
MemberRole      { userId, roleId }                                    PK
Overwrite       { id, targetKind: project|channel|notebook|board, targetId, subjectKind: role|member, subjectId, allow BIGINT UNSIGNED, deny BIGINT UNSIGNED }
                  unique (targetKind, targetId, subjectKind, subjectId); allow & deny must not overlap
AuditLog        { id, teamId, actorId, action, targetKind, targetId, before JSON, after JSON, reason?, createdAt }   index (teamId, createdAt)
```
- `Team.everyonePermissions` (phase 3) becomes the `@everyone` row in `Role` (migration copies it).
- Role `position`: higher = more powerful; `@everyone` is 0; the owner is above all.

## API
- Roles: `GET/POST /api/teams/:id/roles`, `PATCH/DELETE /api/roles/:id`, `PUT /api/teams/:id/roles/order` (reorder), `PUT/DELETE /api/teams/:id/members/:userId/roles/:roleId`.
- Project roles: same under `/api/projects/:id/roles`.
- Overwrites: `GET /api/overwrites?kind=&id=`, `PUT /api/overwrites` (upsert), `DELETE /api/overwrites/:id`.
- Simulator: `GET /api/permissions/preview?subject=role:<id>|member:<id>&kind=&id=` returns the resolved bitfield with, per bit, *why* (which role/overwrite decided).
- Audit: `GET /api/teams/:id/audit?action=&actor=&cursor=` (`VIEW_AUDIT_LOG`).

## Rules enforced by the server
1. `MANAGE_ROLES` is required to touch roles; owner and `ADMINISTRATOR` bypass.
2. Hierarchy: you can create/edit/delete/assign only roles strictly below your highest role; you cannot give a role a permission you do not have; you cannot reorder roles at or above yours.
3. `@everyone` cannot be deleted or have a colour/position change; granting `ADMINISTRATOR` to it requires the owner.
4. Overwrites: you can only allow/deny bits you hold in that context; `MANAGE_PROJECTS` (or the matching `MANAGE_*`) is required on the target.
5. A project role is only valid inside its project subtree; deleting a project deletes its roles and overwrites.
6. Every successful mutation writes one `AuditLog` row in the same transaction (actions: `role.create|update|delete|assign|unassign`, `overwrite.set|clear`, `member.add|remove|nickname`, `project.create|move|delete`, `team.update|owner.transfer`, `quota.override`, later `invite.*`, `channel.*`).

## Web UI
- Team settings → **Roles**: list (drag to reorder), colour, name, "display separately" (hoist), "allow @mention", permission grid grouped as in overview §2.3, with search and short descriptions.
- Team settings → **Members**: per-member role chips, add/remove role, nickname.
- Project settings → **Permissions**: roles and members with per-level overwrite editor.
- **Tri-state control** exactly like Discord overwrites: ✓ allow, – inherit, ✗ deny, per permission, with "synced with parent" indicator and a "reset to inherited" action.
- **View as** (role or member): shows resolved permissions with the deciding source, so admins can debug.
- **Audit log** page: filter by actor/action/date, expandable before/after diff, pagination.
- The `PermissionStore` refreshes on a `permissions.changed` event (socket from phase 6; refresh-on-focus until then).

## i18n keys
`roles.*`, `permissions.<name>` and `permissions.<name>.hint` for all bits, `overwrite.allow|inherit|deny`, `overwrite.syncedWithParent`, `viewAs.*`, `audit.*` (one key per action).

## Security & permissions
- All checks run server-side in one `RoleHierarchy` service; the UI only mirrors them.
- Permission-changing endpoints return 404 to non-members and 403 to members lacking `MANAGE_ROLES`.
- Audit rows are append-only (no update/delete endpoint; DB user for the app has no `DELETE` on the table is documented as optional hardening). Retention setting `AUDIT_RETENTION_DAYS` (default 365) purged by a nightly job.
- Self-lockout protection: the last member holding administrative power cannot demote themselves; the owner cannot leave without transferring.

## Quota impact
Audit rows are small and not charged; retention keeps them bounded. Role/overwrite counts are capped (`MAX_ROLES_PER_TEAM` default 100).

## Implementation steps
1. Models + migration (convert `everyonePermissions`).
2. Extend `PermissionService` to load roles/overwrites for the chain (single batched query) and cache per request.
3. `RoleHierarchy` rules + endpoints + `AuditService.record(tx, …)`.
4. Preview endpoint with decision trace.
5. UI: roles, members, overwrites, view-as, audit.
6. Backfill: existing members get no extra roles; owner unchanged.

## Acceptance criteria
1. [unit] Hierarchy rules: matrix of (actor roles × target role × action) matches the reference table (owner, admin, mid role, lowest role).
2. [unit] Decision trace from the preview names the correct source for every bit in a randomised scenario (compared to the reference engine).
3. [server] A member with `MANAGE_ROLES` but a mid-ranked role cannot edit, delete, assign or grant any role at or above theirs, nor grant a bit they lack; each returns 403 and writes no audit row.
4. [server] Overwrite allow+deny on the same bit is rejected; deny at the project level hides a channel; allow for a member beats a role deny.
5. [server] Deleting a role removes it from members and overwrites in one transaction; deleting a project deletes its roles/overwrites.
6. [server] Each mutation writes exactly one audit row with before/after; a failed mutation writes none; the viewer endpoint requires `VIEW_AUDIT_LOG`.
7. [server] The last administrative member cannot be demoted; the owner cannot be removed.
8. [web e2e] Admin creates "Reviewer" (colour, mentionable), grants *Edit pages* only, assigns to B; B can edit a notebook page but cannot create notebooks; after revoking, B's UI updates and the API refuses.
9. [web e2e] Tri-state: set deny on a project for `@everyone`, allow for role "Dev"; a Dev member sees the project, others do not (404 on the URL).
10. [web e2e] "View as" shows the deciding source for a disabled control; the audit page lists the changes made in the test with correct actors.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).
