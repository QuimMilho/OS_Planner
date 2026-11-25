import type { Locale, Theme, UserDto } from '@notes/shared';
import type { User } from '../generated/prisma/client.js';
import { quotaBytes, type Env } from '../config/env.js';

export function toUserDto(user: User, env: Env): UserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    locale: user.locale as Locale,
    theme: user.theme as Theme,
    emailVerified: user.emailVerifiedAt !== null,
    storageUsedBytes: Number(user.storageUsedBytes),
    storageQuotaBytes: quotaBytes(env),
  };
}
