import { Inject, Injectable } from '@nestjs/common';
import { jwtVerify, SignJWT } from 'jose';
import { ENV, type Env } from '../config/env.js';
import type { AuthUser } from '../common/auth.decorators.js';
import { ACCESS_TTL_SECONDS, MEDIA_TTL_SECONDS } from './auth.constants.js';

const ISSUER = 'notes';
const AUD_API = 'notes-api';
const AUD_MEDIA = 'notes-media';

/** Signs and verifies the short-lived access token and the media token (HS256). */
@Injectable()
export class TokenService {
  private readonly accessKey: Uint8Array;
  private readonly mediaKey: Uint8Array;

  constructor(@Inject(ENV) env: Env) {
    this.accessKey = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
    this.mediaKey = new TextEncoder().encode(env.JWT_MEDIA_SECRET);
  }

  signAccess(userId: string, sessionId: string): Promise<string> {
    return new SignJWT({ sid: sessionId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUD_API)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
      .sign(this.accessKey);
  }

  async verifyAccess(token: string): Promise<AuthUser | null> {
    try {
      const { payload } = await jwtVerify(token, this.accessKey, {
        issuer: ISSUER,
        audience: AUD_API,
        algorithms: ['HS256'],
      });
      if (!payload.sub || typeof payload['sid'] !== 'string') return null;
      return { id: payload.sub, sessionId: payload['sid'] };
    } catch {
      return null;
    }
  }

  /** Scoped token embedded in <img>/<video> URLs, which cannot send an Authorization header. */
  signMedia(userId: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUD_MEDIA)
      .setIssuedAt()
      .setExpirationTime(`${MEDIA_TTL_SECONDS}s`)
      .sign(this.mediaKey);
  }

  /** Returns the user id the media token was issued to, or null if invalid/expired. */
  async verifyMedia(token: string): Promise<string | null> {
    try {
      const { payload } = await jwtVerify(token, this.mediaKey, {
        issuer: ISSUER,
        audience: AUD_MEDIA,
        algorithms: ['HS256'],
      });
      return payload.sub ?? null;
    } catch {
      return null;
    }
  }
}
