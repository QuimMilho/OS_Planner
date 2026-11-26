import { ALL_PERMISSIONS, Permission } from './bits';

/**
 * Who may touch which role. Pure, so the server (authoritative) and the web UI (to hide what would be
 * refused) run the same rules, and a table of cases can pin them down.
 *
 *  - `MANAGE_ROLES` (or `ADMINISTRATOR`, which holds every bit) is needed for anything.
 *  - You can create/edit/delete/assign/unassign only roles strictly *below* your highest role.
 *  - You cannot give a role (or take from it) a permission you do not hold yourself.
 *  - `@everyone` can be edited (its permissions only) but never deleted, and giving it `ADMINISTRATOR` is for the owner.
 *  - The owner is above every role and bypasses all of it, except that `@everyone` still cannot be deleted.
 */

export interface RoleActor {
  isOwner: boolean;
  /** What the person may do in the context the role belongs to (owner and administrators: every bit). */
  perms: bigint;
  /** Highest `position` among the roles that apply to the person there; 0 when they only have @everyone. */
  rank: number;
}

export interface RoleTarget {
  position: number;
  isEveryone: boolean;
  permissions: bigint;
}

export type RoleAction = 'create' | 'edit' | 'delete' | 'assign' | 'unassign';

/** Why an action is refused. All of them are a 403 except `invalid_order` (422). */
export type RoleDenial =
  | 'missing_manage_roles'
  | 'role_at_or_above'
  | 'permission_not_held'
  | 'everyone_protected'
  | 'administrator_owner_only'
  | 'invalid_order';

/** The rank of someone holding these roles: the highest position, 0 for nobody (everyone has @everyone, position 0). */
export const rankOf = (positions: readonly number[]): number =>
  positions.reduce((a, b) => Math.max(a, b), 0);

/**
 * `null` when the action is allowed. `newPermissions` is the permission set the role would have afterwards (for `create`
 * and `edit`); a target is required for every action but `create`.
 */
export function checkRoleAction(
  actor: RoleActor,
  action: RoleAction,
  target: RoleTarget | null,
  newPermissions?: bigint,
): RoleDenial | null {
  if (action === 'delete' && target?.isEveryone) return 'everyone_protected';
  if (!actor.isOwner && (actor.perms & Permission.MANAGE_ROLES) === 0n)
    return 'missing_manage_roles';

  const before = target?.permissions ?? 0n;
  if (target?.isEveryone && newPermissions !== undefined) {
    const addsAdministrator =
      (newPermissions & Permission.ADMINISTRATOR) !== 0n &&
      (before & Permission.ADMINISTRATOR) === 0n;
    if (addsAdministrator && !actor.isOwner) return 'administrator_owner_only';
  }
  if (actor.isOwner) return null;

  if (target && target.position >= actor.rank) return 'role_at_or_above';
  if (newPermissions !== undefined) {
    const changed = (newPermissions ^ before) & ALL_PERMISSIONS;
    if ((changed & ~actor.perms) !== 0n) return 'permission_not_held';
  }
  return null;
}

export interface RankedRole {
  id: string;
  position: number;
}

/**
 * Checks a new order for the roles of one scope (@everyone excluded). `requestedIds` lists every role, most
 * powerful first. Whoever is not the owner cannot move roles at or above their own rank, nor move another role up
 * into that space: the roles from their rank upwards must stay exactly where they are.
 */
export function checkReorder(
  actor: RoleActor,
  current: readonly RankedRole[],
  requestedIds: readonly string[],
): RoleDenial | null {
  if (!actor.isOwner && (actor.perms & Permission.MANAGE_ROLES) === 0n)
    return 'missing_manage_roles';
  const ids = new Set(current.map((r) => r.id));
  if (
    requestedIds.length !== ids.size ||
    new Set(requestedIds).size !== ids.size ||
    requestedIds.some((id) => !ids.has(id))
  )
    return 'invalid_order';
  if (actor.isOwner) return null;
  const locked = [...current]
    .filter((r) => r.position >= actor.rank)
    .sort((a, b) => b.position - a.position);
  for (let i = 0; i < locked.length; i++)
    if (requestedIds[i] !== locked[i]!.id) return 'role_at_or_above';
  return null;
}

/** New positions for roles listed most powerful first: the last gets 1, the first gets `ids.length`. */
export function positionsForOrder(ids: readonly string[]): Map<string, number> {
  return new Map(ids.map((id, i) => [id, ids.length - i]));
}
