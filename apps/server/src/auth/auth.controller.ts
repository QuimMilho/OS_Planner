import { Body, Controller, ForbiddenException, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type AuthResponse,
  type LoginInput,
  type MediaTokenResponse,
  type RegisterInput,
} from '@os-planner/shared';
import type { z } from 'zod';
import { CurrentUser, Public, type AuthUser } from '../common/auth.decorators.js';
import { ENV, isHttps, type Env } from '../config/env.js';
import {
  CSRF_HEADER,
  CSRF_VALUE,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_TTL_MS,
} from './auth.constants.js';
import { AuthService, type ClientContext, type Session } from './auth.service.js';
import { Authz } from '../common/authz.js';

const strict = { default: { limit: 10, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private ctx(req: Request): ClientContext {
    return { userAgent: req.get('user-agent') ?? null, ip: req.ip ?? null };
  }

  private get cookieOptions() {
    return { httpOnly: true, secure: isHttps(this.env), sameSite: this.env.COOKIE_SAMESITE, path: REFRESH_COOKIE_PATH } as const;
  }

  private respond(res: Response, session: Session): AuthResponse {
    res.cookie(REFRESH_COOKIE, session.refreshToken, { ...this.cookieOptions, maxAge: REFRESH_TTL_MS });
    res.setHeader('Cache-Control', 'no-store');
    return session.response;
  }

  private clearCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, this.cookieOptions);
  }

  /** Cookie-authenticated endpoints must carry a header a cross-site form cannot send. */
  private assertCsrf(req: Request): void {
    if (req.get(CSRF_HEADER) !== CSRF_VALUE) throw new ForbiddenException('csrf');
  }

  @Public()
  @Throttle(strict)
  @Authz({ scope: 'public', note: 'creates an account; 10 a minute per address' })
  @Post('register')
  async register(
    @Body({ schema: registerSchema }) body: RegisterInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(res, await this.auth.register(body, this.ctx(req)));
  }

  @Public()
  @Throttle(strict)
  @HttpCode(200)
  @Authz({ scope: 'public', note: '10 a minute per address' })
  @Post('login')
  async login(
    @Body({ schema: loginSchema }) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponse> {
    return this.respond(res, await this.auth.login(body.email, body.password, this.ctx(req)));
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(200)
  @Authz({ scope: 'public', note: 'the refresh cookie and the X-Requested-With header are the credentials' })
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<AuthResponse> {
    this.assertCsrf(req);
    try {
      return this.respond(res, await this.auth.refresh(req.cookies?.[REFRESH_COOKIE], this.ctx(req)));
    } catch (e) {
      this.clearCookie(res);
      throw e;
    }
  }

  @Public()
  @HttpCode(204)
  @Authz({ scope: 'public', note: 'ends the session of the refresh cookie; needs the X-Requested-With header' })
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    this.assertCsrf(req);
    await this.auth.logout(req.cookies?.[REFRESH_COOKIE]);
    this.clearCookie(res);
  }

  @Public()
  @Throttle(strict)
  @HttpCode(200)
  @Authz({ scope: 'secret' })
  @Post('verify-email')
  async verifyEmail(@Body({ schema: verifyEmailSchema }) body: z.infer<typeof verifyEmailSchema>) {
    await this.auth.verifyEmail(body.token);
    return { ok: true };
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Authz({ scope: 'self' })
  @Post('resend-verification')
  async resendVerification(@CurrentUser() user: AuthUser) {
    await this.auth.resendVerification(user.id);
    return { ok: true };
  }

  @Public()
  @Throttle(strict)
  @HttpCode(200)
  @Authz({ scope: 'public', note: 'the same answer whether or not the address has an account' })
  @Post('forgot-password')
  async forgotPassword(@Body({ schema: forgotPasswordSchema }) body: z.infer<typeof forgotPasswordSchema>) {
    await this.auth.forgotPassword(body.email);
    return { ok: true };
  }

  @Public()
  @Throttle(strict)
  @HttpCode(200)
  @Authz({ scope: 'secret' })
  @Post('reset-password')
  async resetPassword(
    @Body({ schema: resetPasswordSchema }) body: z.infer<typeof resetPasswordSchema>,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.resetPassword(body.token, body.password);
    this.clearCookie(res);
    return { ok: true };
  }

  @HttpCode(200)
  @Authz({ scope: 'self' })
  @Post('media-token')
  mediaToken(@CurrentUser() user: AuthUser): Promise<MediaTokenResponse> {
    return this.auth.mediaToken(user.id);
  }
}
