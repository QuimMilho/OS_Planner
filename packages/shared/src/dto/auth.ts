import { z } from 'zod';
import { localeSchema, themeSchema, type Locale, type Theme } from './common';

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
  storageUsedBytes: number;
  storageQuotaBytes: number;
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
