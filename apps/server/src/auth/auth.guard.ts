import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC, REQUIRE_VERIFIED } from '../common/auth.decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TokenService } from './token.service.js';

/** Global guard: every route needs a valid bearer token unless it is marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const user = token ? await this.tokens.verifyAccess(token) : null;
    if (!user) throw new UnauthorizedException('invalid_or_expired_token');
    req.user = user;

    if (this.reflector.getAllAndOverride<boolean>(REQUIRE_VERIFIED, targets)) {
      const row = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { emailVerifiedAt: true },
      });
      if (!row) throw new UnauthorizedException('invalid_or_expired_token');
      if (!row.emailVerifiedAt) throw new ForbiddenException('email_not_verified');
    }
    return true;
  }
}
