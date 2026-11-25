import { BadRequestException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import argon2 from 'argon2';
import type { SessionDto, UpdateMeInput, UserDto } from '@notes/shared';
import { isCommonPassword } from '../auth/common-passwords.js';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { toUserDto } from './user.mapper.js';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async get(userId: string): Promise<UserDto> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException();
    return toUserDto(user, this.env);
  }

  async update(userId: string, input: UpdateMeInput): Promise<UserDto> {
    const user = await this.prisma.user.update({ where: { id: userId }, data: input });
    return toUserDto(user, this.env);
  }

  /** Changes the password and signs out every other session. */
  async changePassword(userId: string, currentSessionId: string, current: string, next: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException();
    if (!(await argon2.verify(user.passwordHash, current).catch(() => false))) {
      throw new UnauthorizedException('invalid_credentials');
    }
    if (isCommonPassword(next)) throw new BadRequestException('password_too_common');
    const passwordHash = await argon2.hash(next, { type: argon2.argon2id });
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null, familyId: { not: currentSessionId } },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  /** One entry per login (token family), described by its most recent token. */
  async sessions(userId: string, currentSessionId: string): Promise<SessionDto[]> {
    const rows = await this.prisma.refreshToken.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    const byFamily = new Map<string, SessionDto>();
    for (const r of rows) {
      if (byFamily.has(r.familyId)) continue;
      byFamily.set(r.familyId, {
        id: r.familyId,
        userAgent: r.userAgent,
        ip: r.ip,
        createdAt: r.createdAt.toISOString(),
        current: r.familyId === currentSessionId,
      });
    }
    return [...byFamily.values()];
  }

  async revokeSession(userId: string, familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
