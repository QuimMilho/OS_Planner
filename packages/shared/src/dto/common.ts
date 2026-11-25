import { z } from 'zod';
import { LIMITS } from '../schema/specs';

export const idSchema = z.uuid();

export const nameSchema = z.string().trim().min(1).max(LIMITS.nameMax);
export const titleSchema = z.string().trim().max(LIMITS.titleMax);

/** Fractional-index key used to order siblings without renumbering them. */
export const positionSchema = z.string().regex(/^[0-9A-Za-z]{1,64}$/);

export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .nullable();
export const iconSchema = z.string().max(40).nullable();

export const localeSchema = z.enum(['en', 'pt']);
export type Locale = z.infer<typeof localeSchema>;

/** `system` follows the operating system (light or dark); the others are fixed. Coloured themes are dark schemes. */
export const THEMES = ['system', 'light', 'dark', 'purple', 'red', 'green', 'blue', 'darkblue'] as const;
export const themeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof themeSchema>;

/** Standard error body returned by the API. */
export interface ApiError {
  statusCode: number;
  error: string;
  message: string;
  details?: unknown;
}
