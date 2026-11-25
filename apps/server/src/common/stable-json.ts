/**
 * JSON with object keys sorted, so two documents that differ only in key order compare equal.
 * (MySQL's JSON column reorders keys, so a stored document never matches the sent one byte for byte.)
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

export const jsonEquals = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);
