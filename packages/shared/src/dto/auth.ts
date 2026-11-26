import { z } from 'zod';
import { localeSchema, themeSchema, type Locale, type Theme } from './common';
import type { QuotaDto } from './quota';

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** Length-based policy (no composition rules); the server additionally rejects the very common ones. */
export const passwordSchema = z.string().min(10, 'at least 10 characters').max(128);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(80),
  locale: localeSchema.default('en'),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const tokenSchema = z.string().min(20).max(200);

export const verifyEmailSchema = z.object({ token: tokenSchema });
export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({ token: tokenSchema, password: passwordSchema });
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const updateMeSchema = z
  .object({
    displayName: z.string().trim().min(1).max(80),
    locale: localeSchema,
    theme: themeSchema,
  })
  .partial();
export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  locale: Locale;
  theme: Theme;
  emailVerified: boolean;
  /** Same numbers as `quota`; kept for older clients. */
  storageUsedBytes: number;
  storageQuotaBytes: number;
  /** An instance administrator: listed in ADMIN_EMAILS with a verified address. */
  isAdmin: boolean;
  /** The personal storage of this account. */
  quota: QuotaDto;
  /** The account's own space: its notebooks, sync cursor and storage. */
  personalSpaceId: string;
  /** The account own space: its notebooks, sync cursor and storage. */
  personalSpaceId: string;
}

export interface AuthResponse {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  user: UserDto;
}

export interface MediaTokenResponse {
  token: string;
  expiresIn: number;
}

export interface SessionDto {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  current: boolean;
}
