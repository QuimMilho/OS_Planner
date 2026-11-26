import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { TokenService } from '../auth/token.service.js';
import type { AuthUser } from '../common/auth.decorators.js';
import { ENV, isAdminEmail, type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Instance administrators only: an address listed in ADMIN_EMAILS *and verified*. Registering
 * somebody else's address therefore grants nothing.
 *
 * Everybody else (signed out, signed in but not an admin, admin with an unverified address) gets
 * 404, exactly as if the route did not exist. Routes behind this guard are marked `@Public()` so
 * the global guard does not answer 401 first; this guard checks the token itself.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const auth = token ? await this.tokens.verifyAccess(token) : null;
    if (!auth) throw new NotFoundException();

    const user = await this.prisma.user.findUnique({
      where: { id: auth.id },
      select: { email: true, emailVerifiedAt: true },
    });
    if (!user?.emailVerifiedAt || !isAdminEmail(this.env, user.email))
      throw new NotFoundException();

    req.user = auth;
    return true;
  }
}
