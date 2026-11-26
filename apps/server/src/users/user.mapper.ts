import type { Locale, QuotaDto, Theme, UserDto } from '@os-planner/shared';
import type { User } from '../generated/prisma/client.js';
import { isAdminEmail, type Env } from '../config/env.js';

/** `quota` is the person's own storage as decided by QuotaService (default or admin override). */
export function toUserDto(user: User, env: Env, quota: QuotaDto, personalSpaceId: string): UserDto {
  const verified = user.emailVerifiedAt !== null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    locale: user.locale as Locale,
    theme: user.theme as Theme,
    emailVerified: verified,
    storageUsedBytes: quota.used,
    storageQuotaBytes: quota.limit,
    isAdmin: verified && isAdminEmail(env, user.email),
    quota,
    personalSpaceId,
  };
}
