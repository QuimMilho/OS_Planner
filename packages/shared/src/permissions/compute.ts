import { ALL_PERMISSIONS, Permission } from './bits';

/** One allow/deny pair. */
export interface Overwrite {
  allow: bigint;
  deny: bigint;
}

/**
 * The overwrites set on one level of the tree (a project, a sub-project, or a channel). Each one is
 * optional: most levels have none at all.
 */
export interface Level {
  /** What the level is (a project id, later a channel id). Only used to say where a decision was made. */
  ref?: string;
  /** For @everyone. */
  everyone?: Overwrite;
  /** By role id. Only the roles the member holds are applied. */
  roles?: Readonly<Record<string, Overwrite>>;
  /** By user id. Only the member's own entry is applied. */
  members?: Readonly<Record<string, Overwrite>>;
}

export interface PermissionInput {
  userId: string;
  /** The team's owner, or null while the owner has not accepted yet. */
  ownerId: string | null;
  /** Permissions of @everyone. */
  everyone: bigint;
  /** Permissions of each role by id (only roles the member holds matter). */
  roles?: Readonly<Record<string, bigint>>;
  /** Role ids this member holds. Unknown ids are ignored. */
  memberRoleIds?: readonly string[];
  /** From the root project down to the context's project. */
  chain?: readonly Level[];
  /** The channel inside the last project, if the question is about a channel. */
  channel?: Level;
}

/**
 * Permissions that mean nothing without being able to see the container they act in. Without the
 * `VIEW_*` bit of the container all of them are removed, whatever else granted them.
 */
export const GATED_BY: ReadonlyArray<{ view: bigint; dependents: bigint }> = [
  {
    view: Permission.VIEW_CHANNEL,
    dependents:
      Permission.SEND_MESSAGES |
      Permission.READ_MESSAGE_HISTORY |
      Permission.ATTACH_FILES |
      Permission.ADD_REACTIONS |
      Permission.CREATE_THREADS |
      Permission.SEND_IN_THREADS |
      Permission.MENTION_EVERYONE |
      Permission.MANAGE_MESSAGES |
      Permission.CONNECT |
      Permission.SPEAK |
      Permission.VIDEO |
      Permission.SCREEN_SHARE |
      Permission.MUTE_MEMBERS |
      Permission.MOVE_MEMBERS,
  },
  {
    view: Permission.VIEW_NOTEBOOKS,
    dependents:
      Permission.CREATE_NOTEBOOKS |
      Permission.EDIT_PAGES |
      Permission.DELETE_PAGES |
      Permission.MANAGE_NOTEBOOKS |
      Permission.SHARE_NOTEBOOKS,
  },
  {
    view: Permission.VIEW_BOARDS,
    dependents:
      Permission.CREATE_TASKS |
      Permission.EDIT_TASKS |
      Permission.ASSIGN_TASKS |
      Permission.MANAGE_BOARDS |
      Permission.MANAGE_LABELS,
  },
  {
    view: Permission.VIEW_CALENDAR,
    dependents:
      Permission.CREATE_MEETINGS | Permission.MANAGE_MEETINGS | Permission.ADD_TO_MEMBER_CALENDARS,
  },
];

/** Removes what cannot be used because the matching `VIEW_*` bit is missing. */
export function maskUnviewable(set: bigint): bigint {
  let out = set;
  for (const { view, dependents } of GATED_BY) if ((out & view) === 0n) out &= ~dependents;
  return out;
}

const applyPair = (set: bigint, deny: bigint, allow: bigint): bigint => (set & ~deny) | allow;

/** Applies one level in Discord order: @everyone, then the member's roles (all denies, then all allows), then the member. */
function applyLevel(
  set: bigint,
  level: Level | undefined,
  userId: string,
  memberRoleIds: readonly string[],
): bigint {
  if (!level) return set;
  let out = set;
  if (level.everyone) out = applyPair(out, level.everyone.deny, level.everyone.allow);
  if (level.roles) {
    let deny = 0n;
    let allow = 0n;
    for (const roleId of memberRoleIds) {
      const o = Object.hasOwn(level.roles, roleId) ? level.roles[roleId] : undefined;
      if (o) {
        deny |= o.deny;
        allow |= o.allow;
      }
    }
    out = applyPair(out, deny, allow);
  }
  const mine =
    level.members && Object.hasOwn(level.members, userId) ? level.members[userId] : undefined;
  if (mine) out = applyPair(out, mine.deny, mine.allow);
  return out;
}

/**
 * What a member may do in a context. Pure and total: any input gives an answer.
 *
 *  1. The team's owner, or anyone holding ADMINISTRATOR (through @everyone or a role), has everything.
 *  2. Otherwise start from @everyone plus every role the member holds.
 *  3. Walk the tree from the root project down to the context's project, then the channel. At each
 *     level apply @everyone's deny/allow, the member's roles' deny then allow, then the member's own
 *     deny/allow. A later (more specific) level therefore beats an earlier one, and a member-specific
 *     allow beats a role deny on the same level.
 *  4. Mask: without the `VIEW_*` bit of a container, everything that acts inside it is removed.
 */
export function computePermissions(input: PermissionInput): bigint {
  const roles = input.roles ?? {};
  const memberRoleIds = (input.memberRoleIds ?? []).filter((id) => Object.hasOwn(roles, id));

  if (input.ownerId !== null && input.userId === input.ownerId) return ALL_PERMISSIONS;

  let base = input.everyone;
  for (const id of memberRoleIds) base |= roles[id]!;
  if ((base & Permission.ADMINISTRATOR) !== 0n) return ALL_PERMISSIONS;

  let set = base;
  for (const level of input.chain ?? []) set = applyLevel(set, level, input.userId, memberRoleIds);
  set = applyLevel(set, input.channel, input.userId, memberRoleIds);

  return maskUnviewable(set & ALL_PERMISSIONS);
}
