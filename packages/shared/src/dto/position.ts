import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';

/** Key that sorts strictly between two siblings (either may be null for "start"/"end"). */
export function positionBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}

/**
 * Inserting again and again at the same spot makes keys longer (about a character per six inserts). The column holds 64
 * characters, so a list whose keys pass this length is given fresh, short ones (`evenPositions`) while keeping its order.
 */
export const POSITION_REBALANCE_LENGTH = 40;

/** `count` keys in order that are as short as they can be: what a list is re-keyed with. */
export function evenPositions(count: number): string[] {
  return count <= 0 ? [] : generateNKeysBetween(null, null, count);
}

/** The order the server and every client sort siblings in: by key (code points), then by id for equal keys. */
export function comparePositions(a: { position: string; id: string }, b: { position: string; id: string }): number {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
