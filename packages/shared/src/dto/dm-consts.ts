// The few direct-message constants the website needs on its first load. No schemas here (zod is not free): those are in ./dm.

export const DM_LIMITS = {
  /** Conversations listed at once. */
  listMax: 200,
  /** People the "new message" picker returns. */
  peopleMax: 200,
  /** Blocked people one person can keep. */
  blocksMax: 500,
} as const;

/** Who may start a conversation with a person: people who share a team with them, or nobody. */
export const ALLOW_DMS_FROM = ['members', 'nobody'] as const;
export type AllowDmsFrom = (typeof ALLOW_DMS_FROM)[number];

/** The answer to every refusal of a direct message: it never says why (blocked, closed to everyone, no common team ...). */
export const DM_NOT_ALLOWED = 'dm_not_allowed';
