import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** Opaque, URL-safe random token (256 bits). */
export const randomToken = (): string => randomBytes(32).toString('base64url');

/** Tokens are only ever stored as their SHA-256 hash, so a database leak does not leak sessions. */
export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export const newId = (): string => randomUUID();

/** Compares two hex digests of the same length without leaking where they differ. */
export const safeEqualHex = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
