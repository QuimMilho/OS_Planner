import { ALL_PERMISSIONS, PERMISSION_NAMES, Permission, type PermissionName } from './bits';
import {
  GATED_BY,
  computePermissions,
  type Level,
  type Overwrite,
  type PermissionInput,
} from './compute';

/** Why one permission is on or off for someone. The last step that touched the bit decides. */
export type Reason =
  /** The team's owner has everything. */
  | { kind: 'owner' }
  /** `ADMINISTRATOR` through @everyone (`roleIds` empty) or through these roles. */
  | { kind: 'administrator'; roleIds: string[] }
  /** Granted by the base: @everyone (`everyone`) and/or these roles. */
  | { kind: 'base'; everyone: boolean; roleIds: string[] }
  /** Set by an overwrite. `level` is the `ref` of the level (project id) or `null` when it has none. */
  | {
      kind: 'overwrite';
      level: string | null;
      subject: 'everyone' | 'roles' | 'member';
      roleIds: string[];
      effect: 'allow' | 'deny';
    }
  /** Taken away because the matching `VIEW_*` permission is missing. */
  | { kind: 'masked'; missing: PermissionName }
  /** Nothing ever granted it. */
  | { kind: 'none' };

export interface Decision {
  permission: PermissionName;
  granted: boolean;
  reason: Reason;
}

export interface Explanation {
  permissions: bigint;
  decisions: Decision[];
}

const NONE: Reason = { kind: 'none' };
const on = (set: bigint, bit: bigint): boolean => (set & bit) !== 0n;

/**
 * The same answer as `computePermissions`, with the step that decided each permission. Used by the "view as"
 * simulator, so an administrator can see why a control is disabled for someone.
 */
export function explainPermissions(input: PermissionInput): Explanation {
  const permissions = computePermissions(input);
  const roles = input.roles ?? {};
  const held = (input.memberRoleIds ?? []).filter((id) => Object.hasOwn(roles, id));

  const all = (reason: Reason): Explanation => ({
    permissions,
    decisions: PERMISSION_NAMES.map((permission) => ({ permission, granted: true, reason })),
  });
  if (input.ownerId !== null && input.userId === input.ownerId) return all({ kind: 'owner' });

  const everyoneAdmin = on(input.everyone, Permission.ADMINISTRATOR);
  const adminRoles = held.filter((id) => on(roles[id]!, Permission.ADMINISTRATOR));
  if (everyoneAdmin || adminRoles.length)
    return all({ kind: 'administrator', roleIds: everyoneAdmin ? [] : adminRoles });

  const state = new Map<PermissionName, Decision>();
  for (const permission of PERMISSION_NAMES) {
    const bit = Permission[permission];
    const fromEveryone = on(input.everyone, bit);
    const fromRoles = held.filter((id) => on(roles[id]!, bit));
    const granted = fromEveryone || fromRoles.length > 0;
    state.set(permission, {
      permission,
      granted,
      reason: granted ? { kind: 'base', everyone: fromEveryone, roleIds: fromRoles } : NONE,
    });
  }

  const apply = (
    bits: bigint,
    effect: 'allow' | 'deny',
    level: string | null,
    subject: 'everyone' | 'roles' | 'member',
    roleIds: string[],
  ): void => {
    for (const permission of PERMISSION_NAMES) {
      if (!on(bits, Permission[permission])) continue;
      state.set(permission, {
        permission,
        granted: effect === 'allow',
        reason: { kind: 'overwrite', level, subject, roleIds, effect },
      });
    }
  };
  const pair = (
    o: Overwrite,
    level: string | null,
    subject: 'everyone' | 'roles' | 'member',
    roleIds: string[],
  ): void => {
    apply(o.deny, 'deny', level, subject, roleIds); // deny first, so an allow in the same pair wins
    apply(o.allow, 'allow', level, subject, roleIds);
  };

  const level = (lv: Level | undefined): void => {
    if (!lv) return;
    const ref = lv.ref ?? null;
    if (lv.everyone) pair(lv.everyone, ref, 'everyone', []);
    if (lv.roles) {
      const mine = held.filter((id) => Object.hasOwn(lv.roles!, id));
      const denyRoles = mine.filter((id) => lv.roles![id]!.deny !== 0n);
      const allowRoles = mine.filter((id) => lv.roles![id]!.allow !== 0n);
      let deny = 0n;
      let allow = 0n;
      for (const id of mine) {
        deny |= lv.roles[id]!.deny;
        allow |= lv.roles[id]!.allow;
      }
      // The roles act together: which roles are named depends on the bit, so name them per effect.
      for (const permission of PERMISSION_NAMES) {
        const bit = Permission[permission];
        if (on(deny, bit))
          state.set(permission, {
            permission,
            granted: false,
            reason: {
              kind: 'overwrite',
              level: ref,
              subject: 'roles',
              roleIds: denyRoles.filter((id) => on(lv.roles![id]!.deny, bit)),
              effect: 'deny',
            },
          });
      }
      for (const permission of PERMISSION_NAMES) {
        const bit = Permission[permission];
        if (on(allow, bit))
          state.set(permission, {
            permission,
            granted: true,
            reason: {
              kind: 'overwrite',
              level: ref,
              subject: 'roles',
              roleIds: allowRoles.filter((id) => on(lv.roles![id]!.allow, bit)),
              effect: 'allow',
            },
          });
      }
    }
    const own =
      lv.members && Object.hasOwn(lv.members, input.userId) ? lv.members[input.userId] : undefined;
    if (own) pair(own, ref, 'member', []);
  };
  for (const lv of input.chain ?? []) level(lv);
  level(input.channel);

  // Without the VIEW_* bit of a container everything that acts inside it is taken away.
  for (const { view, dependents } of GATED_BY) {
    if (on(permissionsOf(state), view)) continue;
    const missing = PERMISSION_NAMES.find((n) => Permission[n] === view)!;
    for (const permission of PERMISSION_NAMES) {
      const d = state.get(permission)!;
      if (d.granted && on(dependents, Permission[permission]))
        state.set(permission, { permission, granted: false, reason: { kind: 'masked', missing } });
    }
  }
  return { permissions, decisions: PERMISSION_NAMES.map((n) => state.get(n)!) };
}

function permissionsOf(state: Map<PermissionName, Decision>): bigint {
  let set = 0n;
  for (const d of state.values()) if (d.granted) set |= Permission[d.permission];
  return set & ALL_PERMISSIONS;
}
