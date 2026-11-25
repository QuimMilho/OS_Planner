import { generateKeyBetween } from 'fractional-indexing';

/** Key that sorts strictly between two siblings (either may be null for "start"/"end"). */
export function positionBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}
