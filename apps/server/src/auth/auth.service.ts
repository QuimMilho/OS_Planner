import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import argon2 from 'argon2';
import type { AuthResponse, Locale, MediaTokenResponse, RegisterInput } from '@os-planner/shared';
import { ENV, type Env } from '../config/env.js';
import { newId, randomToken, sha256Hex } from '../common/crypto.js';
import { MailService } from '../mail/mail.service.js';
import { InvitesService } from '../membership/invites.service.js';
import { SharesService } from '../sharing/shares.service.js';
import { EventBus } from '../events/event-bus.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SpacesService } from '../spaces/spaces.service.js';
import { TeamsService } from '../teams/teams.service.js';
import { QuotaService } from '../quota/quota.service.js';
import { toUserDto } from '../users/user.mapper.js';
import type { User } from '../generated/prisma/client.js';
import {
  ACCESS_TTL_SECONDS,
  EMAIL_VERIFY_TTL_MS,
  MEDIA_TTL_SECONDS,
  PASSWORD_RESET_TTL_MS,
  REFRESH_GRACE_MS,
  REFRESH_TTL_MS,
} from './auth.constants.js';
import { isCommonPassword } from './common-passwords.js';
import { TokenService } from './token.service.js';

export interface ClientContext {
  userAgent: string | null;
  ip: string | null;
}

export interface Session {
  response: AuthResponse;
  /** Opaque refresh token; the controller puts it in an httpOnly cookie. */
  refreshToken: string;
}

const RESEND_COOLDOWN_MS = 60_000;

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);
  /** Verified against when the email is unknown so login timing does not reveal which emails exist. */
  private readonly dummyHash: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly mail: MailService,
    private readonly quota: QuotaService,
    private readonly spaces: SpacesService,
    private readonly teams: TeamsService,
    private readonly invites: InvitesService,
    private readonly shares: SharesService,
    private readonly bus: EventBus,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.dummyHash = argon2.hash('not-a-real-password', { type: argon2.argon2id });
  }

  // ---------------------------------------------------------------- register / login

  async register(input: RegisterInput, ctx: ClientContext): Promise<Session> {
    if (isCommonPassword(input.password)) throw new BadRequestException('password_too_common');
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });

    let user: User;
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            id: newId(),
            email: input.email,
            passwordHash,
            displayName: input.displayName,
            locale: input.locale,
          },
        });
        await this.spaces.createPersonal(tx, created.id); // every account has a space of its own
        return created;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('email_taken');
      throw e;
    }
    // An invite the visitor came with is applied once the address is verified (see claimJoins).
    if (input.inviteToken) await this.invites.attachToRegistration(user.id, input.inviteToken);

    void this.sendVerificationMail(user);
    return this.issueSession(user, ctx);
  }

  async login(email: string, password: string, ctx: ClientContext): Promise<Session> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const hash = user?.passwordHash ?? (await this.dummyHash);
    const ok = await argon2.verify(hash, password).catch(() => false);
    if (!user || !ok) throw new UnauthorizedException('invalid_credentials');
    await this.claimJoins(user.id); // teams created for this address wait for a verified sign-in
    return this.issueSession(user, ctx);
  }

  // ---------------------------------------------------------------- sessions

  private async issueSession(user: User, ctx: ClientContext, familyId = newId()): Promise<Session> {
    const refreshToken = randomToken();
    await this.prisma.refreshToken.create({
      data: {
        id: newId(),
        userId: user.id,
        familyId,
        tokenHash: sha256Hex(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        userAgent: ctx.userAgent?.slice(0, 255) ?? null,
        ip: ctx.ip?.slice(0, 45) ?? null,
      },
    });
    return { response: await this.authResponse(user, familyId), refreshToken };
  }

  private async authResponse(user: User, sessionId: string): Promise<AuthResponse> {
    return {
      accessToken: await this.tokens.signAccess(user.id, sessionId),
      expiresIn: ACCESS_TTL_SECONDS,
      user: toUserDto(user, this.env, await this.quota.userQuota(user.id), await this.spaces.personalSpaceId(user.id)),
    };
  }

  /**
   * Rotates the refresh token. Presenting an already-rotated token is either theft or a race
   * between two tabs: within a short grace window it is treated as the race; after that the
   * whole token family is revoked.
   */
  async refresh(rawToken: string | undefined, ctx: ClientContext): Promise<Session> {
    if (!rawToken) throw new UnauthorizedException('no_session');
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256Hex(rawToken) } });
    const now = new Date();
    if (!row || row.expiresAt <= now) throw new UnauthorizedException('no_session');

    let rotatedRecently = false;
    if (row.revokedAt) {
      if (!row.replacedById) throw new UnauthorizedException('no_session'); // logout / password reset
      if (now.getTime() - row.revokedAt.getTime() > REFRESH_GRACE_MS) {
        await this.revokeFamily(row.familyId);
        await this.bus.publish('session.revoked', { userId: row.userId, sessionId: row.familyId, reason: 'revoked' });
        this.log.warn(`Refresh token reuse detected for user ${row.userId}; session revoked`);
        throw new UnauthorizedException('no_session');
      }
      rotatedRecently = true;
    }

    const user = await this.prisma.user.findUnique({ where: { id: row.userId } });
    if (!user) throw new UnauthorizedException('no_session');
    await this.claimJoins(user.id);

    const refreshToken = randomToken();
    const childId = newId();
    await this.prisma.$transaction(async (tx) => {
      if (!rotatedRecently) {
        // Only the first of two simultaneous requests marks the parent as replaced.
        await tx.refreshToken.updateMany({
          where: { id: row.id, revokedAt: null },
          data: { revokedAt: now, replacedById: childId },
        });
      }
      await tx.refreshToken.create({
        data: {
          id: childId,
          userId: row.userId,
          familyId: row.familyId,
          tokenHash: sha256Hex(refreshToken),
          expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
          userAgent: ctx.userAgent?.slice(0, 255) ?? row.userAgent,
          ip: ctx.ip?.slice(0, 45) ?? row.ip,
        },
      });
    });
    return { response: await this.authResponse(user, row.familyId), refreshToken };
  }

  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256Hex(rawToken) } });
    if (row) {
      await this.revokeFamily(row.familyId);
      await this.bus.publish('session.revoked', { userId: row.userId, sessionId: row.familyId, reason: 'signed_out' });
    }
  }

  revokeFamily(familyId: string): Promise<unknown> {
    return this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async mediaToken(userId: string): Promise<MediaTokenResponse> {
    return { token: await this.tokens.signMedia(userId), expiresIn: MEDIA_TTL_SECONDS };
  }

  // ---------------------------------------------------------------- email verification

  private async createEmailToken(userId: string, type: 'verify' | 'reset', ttlMs: number): Promise<string> {
    const token = randomToken();
    await this.prisma.emailToken.create({
      data: { id: newId(), userId, type, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + ttlMs) },
    });
    return token;
  }

  private async sendVerificationMail(user: User): Promise<void> {
    const token = await this.createEmailToken(user.id, 'verify', EMAIL_VERIFY_TTL_MS);
    await this.mail.sendVerification(user.email, user.displayName, user.locale as Locale, token);
  }

  async verifyEmail(token: string): Promise<void> {
    const row = await this.prisma.emailToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: true },
    });
    if (!row || row.type !== 'verify') throw new BadRequestException('invalid_or_expired_token');
    // Opening the link twice (mail scanners, double clicks) must not turn into an error.
    if (row.usedAt) {
      if (row.user.emailVerifiedAt) return;
      throw new BadRequestException('invalid_or_expired_token');
    }
    if (row.expiresAt <= new Date()) throw new BadRequestException('invalid_or_expired_token');

    await this.prisma.$transaction([
      this.prisma.emailToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      this.prisma.user.update({
        where: { id: row.userId },
        data: { emailVerifiedAt: row.user.emailVerifiedAt ?? new Date() },
      }),
    ]);
    await this.claimJoins(row.userId);
  }

  async resendVerification(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.emailVerifiedAt) return;
    const recent = await this.prisma.emailToken.findFirst({
      where: { userId, type: 'verify', createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) } },
    });
    if (recent) return;
    void this.sendVerificationMail(user);
  }

  // ---------------------------------------------------------------- password reset

  /** Always resolves the same way, so the endpoint cannot be used to probe which emails exist. */
  async forgotPassword(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return;
    const recent = await this.prisma.emailToken.findFirst({
      where: { userId: user.id, type: 'reset', createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) } },
    });
    if (recent) return;
    await this.prisma.emailToken.updateMany({
      where: { userId: user.id, type: 'reset', usedAt: null },
      data: { usedAt: new Date() },
    });
    const token = await this.createEmailToken(user.id, 'reset', PASSWORD_RESET_TTL_MS);
    // Deliberately not awaited: response time must not depend on whether the account exists.
    void this.mail.sendPasswordReset(user.email, user.displayName, user.locale as Locale, token);
  }

  async resetPassword(token: string, password: string): Promise<void> {
    if (isCommonPassword(password)) throw new BadRequestException('password_too_common');
    const row = await this.prisma.emailToken.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!row || row.type !== 'reset' || row.usedAt || row.expiresAt <= new Date()) {
      throw new BadRequestException('invalid_or_expired_token');
    }
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Claim the token atomically so two concurrent submissions cannot both succeed.
      const claimed = await tx.emailToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: now },
      });
      if (claimed.count === 0) throw new BadRequestException('invalid_or_expired_token');
      await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
      // Completing a reset proves the owner controls the mailbox.
      await tx.user.updateMany({ where: { id: row.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
      await tx.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: now } });
    });
    await this.bus.publish('session.revoked', { userId: row.userId, reason: 'password_changed' });
    await this.claimJoins(row.userId);
  }

  /**
   * What waits for a verified address: teams created for it (ownership), the invite the person registered with, and notebooks shared with the address.
   * Both do nothing for an unverified account, so it is safe to call on every sign-in and refresh.
   */
  private async claimJoins(userId: string): Promise<void> {
    await this.teams.claimPending(userId);
    await this.invites.applyPending(userId);
    await this.shares.applyPending(userId);
  }
}
