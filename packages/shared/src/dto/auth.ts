import { z } from 'zod';
import { PRESENCE_MODES, type PresenceMode } from './realtime-consts';
import { localeSchema, themeSchema, type Locale, type Theme } from './common';
import type { QuotaDto } from './quota';
import { ALLOW_DMS_FROM, type AllowDmsFrom } from './dm-consts';

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

/** Length-based policy (no composition rules); the server additionally rejects the very common ones. */
export const passwordSchema = z.string().min(10, 'at least 10 characters').max(128);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(80),
  locale: localeSchema.default('en'),
  /** The token of an invite the visitor came with; it is applied once the email address is verified. */
  inviteToken: z.string().min(20).max(200).optional(),
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
    presenceMode: z.enum(PRESENCE_MODES),
    allowDMsFrom: z.enum(ALLOW_DMS_FROM),
  })
  .partial();
export type UpdateMeInput = z.infer<typeof updateMeSchema>;

export interface UserDto {
  id: string;
  email: string;
  displayName: string;
  locale: Locale;
  theme: Theme;
  /** "invisible" makes the person appear offline to everyone else. */
  presenceMode: PresenceMode;
  /** Who may start a direct message with this person. */
  allowDMsFrom: AllowDmsFrom;
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
