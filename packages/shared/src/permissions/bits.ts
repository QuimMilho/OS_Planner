/**
 * Permissions are a BigInt bit field (stored as BIGINT UNSIGNED, sent as decimal strings). The same
 * code runs on the server (guards) and in the web UI (hide/disable); the server is authoritative.
 *
 * Bit numbers are part of the stored data: a phase may add bits, but nothing is ever renumbered.
 * Bits 39–63 are reserved.
 */
export const Permission = {
  ADMINISTRATOR: 1n << 0n,
  MANAGE_TEAM: 1n << 1n,
  MANAGE_ROLES: 1n << 2n,
  MANAGE_MEMBERS: 1n << 3n,
  CREATE_INVITES: 1n << 4n,
  VIEW_AUDIT_LOG: 1n << 5n,
  MANAGE_PROJECTS: 1n << 6n,
  VIEW_CHANNEL: 1n << 7n,
  SEND_MESSAGES: 1n << 8n,
  READ_MESSAGE_HISTORY: 1n << 9n,
  ATTACH_FILES: 1n << 10n,
  ADD_REACTIONS: 1n << 11n,
  CREATE_THREADS: 1n << 12n,
  SEND_IN_THREADS: 1n << 13n,
  MENTION_EVERYONE: 1n << 14n,
  MANAGE_MESSAGES: 1n << 15n,
  MANAGE_CHANNELS: 1n << 16n,
  VIEW_NOTEBOOKS: 1n << 17n,
  CREATE_NOTEBOOKS: 1n << 18n,
  EDIT_PAGES: 1n << 19n,
  DELETE_PAGES: 1n << 20n,
  MANAGE_NOTEBOOKS: 1n << 21n,
  SHARE_NOTEBOOKS: 1n << 22n,
  VIEW_BOARDS: 1n << 23n,
  CREATE_TASKS: 1n << 24n,
  EDIT_TASKS: 1n << 25n,
  ASSIGN_TASKS: 1n << 26n,
  MANAGE_BOARDS: 1n << 27n,
  MANAGE_LABELS: 1n << 28n,
  VIEW_CALENDAR: 1n << 29n,
  CREATE_MEETINGS: 1n << 30n,
  MANAGE_MEETINGS: 1n << 31n,
  ADD_TO_MEMBER_CALENDARS: 1n << 32n,
  CONNECT: 1n << 33n,
  SPEAK: 1n << 34n,
  VIDEO: 1n << 35n,
  SCREEN_SHARE: 1n << 36n,
  MUTE_MEMBERS: 1n << 37n,
  MOVE_MEMBERS: 1n << 38n,
} as const;

export type PermissionName = keyof typeof Permission;

/** Every defined permission. What an owner or an administrator holds. */
export const ALL_PERMISSIONS: bigint = Object.values(Permission).reduce((a, b) => a | b, 0n);

export const PERMISSION_NAMES = Object.keys(Permission) as PermissionName[];

/** What every member gets unless a team changes it: look around, read and write messages, see notebooks, boards and the calendar. */
export const DEFAULT_EVERYONE: bigint =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.READ_MESSAGE_HISTORY |
  Permission.VIEW_NOTEBOOKS |
  Permission.VIEW_BOARDS |
  Permission.VIEW_CALENDAR;

/** Largest value a BIGINT UNSIGNED column holds. */
const MAX_U64 = (1n << 64n) - 1n;

/** True when every bit of `needed` is set in `set`. */
export const has = (set: bigint, needed: bigint): boolean => (set & needed) === needed;

/** True when all of `needed` are set. (Same as `has`; reads better with a list.) */
export const all = (set: bigint, ...needed: bigint[]): boolean => needed.every((n) => has(set, n));

/** True when none of `unwanted` is set. */
export const none = (set: bigint, ...unwanted: bigint[]): boolean =>
  unwanted.every((n) => (set & n) === 0n);

export const toString = (set: bigint): string => set.toString(10);

/** Parses a decimal string; returns null for anything that is not a non-negative integer below 2^64. */
export function fromString(value: string): bigint | null {
  if (!/^\d{1,20}$/.test(value)) return null;
  const n = BigInt(value);
  return n <= MAX_U64 ? n : null;
}

/** Names of the permissions set in `set`, for logs and tests. */
export const namesOf = (set: bigint): PermissionName[] =>
  PERMISSION_NAMES.filter((n) => has(set, Permission[n]));
