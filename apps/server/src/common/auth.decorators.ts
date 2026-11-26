import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  id: string;
  /** Refresh-token family of the session that issued this access token. */
  sessionId: string;
  /** When the access token stops being valid (seconds since the epoch). */
  expiresAt?: number;
}

export const IS_PUBLIC = 'isPublic';
/** Opts a route out of the global access-token guard. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const REQUIRE_VERIFIED = 'requireVerified';
/** Route needs a verified email address (uploads and PDF export). */
export const RequireVerified = () => SetMetadata(REQUIRE_VERIFIED, true);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user as AuthUser;
});
