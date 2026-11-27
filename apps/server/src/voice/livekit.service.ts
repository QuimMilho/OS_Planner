import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import type { VoiceSource } from '@os-planner/shared';
import { VOICE_LIMITS } from '@os-planner/shared';
import { ENV, voiceEnabled, type Env } from '../config/env.js';

/** What a token lets one person do in one room. */
export interface RoomGrant {
  room: string;
  identity: string;
  name: string;
  /** Free text the other participants see (JSON: colour). */
  metadata: string;
  attributes: Record<string, string>;
  sources: VoiceSource[];
}

/** The slice of a LiveKit webhook the server uses. */
export interface LiveKitEvent {
  id: string;
  event: string;
  /** Unix seconds, from the media server's clock. */
  createdAt: number;
  room?: { name?: string };
  participant?: { sid?: string; identity?: string; joinedAt?: number | string };
}

export interface LiveKitTrack {
  sid: string;
  type: string;
  source: string;
  muted: boolean;
}

export interface LiveKitParticipant {
  sid: string;
  identity: string;
  tracks: LiveKitTrack[];
}

/** The names LiveKit's JSON API uses for the track sources. */
const SOURCE_ENUM: Record<VoiceSource, string> = {
  microphone: 'MICROPHONE',
  camera: 'CAMERA',
  screen_share: 'SCREEN_SHARE',
  screen_share_audio: 'SCREEN_SHARE_AUDIO',
};

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Everything this server says to (and hears from) the media server. LiveKit is never trusted to decide who may join: this server
 * issues short-lived tokens whose grants come from the permission engine, and takes people out through the room API when that
 * changes. Access tokens and API calls are plain HS256 JWTs and Twirp JSON requests, so there is no SDK to carry (and tests
 * stand a small fake server in LiveKit's place).
 */
@Injectable()
export class LiveKitService {
  private readonly log = new Logger(LiveKitService.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  get enabled(): boolean {
    return voiceEnabled(this.env);
  }

  /** The address of the media server for browsers. */
  get publicUrl(): string {
    return this.env.LIVEKIT_URL ?? '';
  }

  private get key(): Uint8Array {
    return enc(this.env.LIVEKIT_API_SECRET ?? '');
  }

  private get apiBase(): string {
    return this.env.LIVEKIT_API_URL ?? (this.env.LIVEKIT_URL ?? '').replace(/^ws/i, 'http');
  }

  // ---------------------------------------------------------------- tokens

  /** The token a browser hands to the media server to join one room, valid for `VOICE_LIMITS.tokenSeconds`. */
  async accessToken(
    grant: RoomGrant,
    now = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(now.getTime() + VOICE_LIMITS.tokenSeconds * 1000);
    const token = await new SignJWT({
      name: grant.name,
      metadata: grant.metadata,
      attributes: grant.attributes,
      video: {
        room: grant.room,
        roomJoin: true,
        canSubscribe: true,
        canPublish: grant.sources.length > 0,
        canPublishData: false,
        canUpdateOwnMetadata: false,
        canPublishSources: grant.sources,
      },
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.env.LIVEKIT_API_KEY ?? '')
      .setSubject(grant.identity)
      .setNotBefore(Math.floor(now.getTime() / 1000) - 5)
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.key);
    return { token, expiresAt };
  }

  /** The event inside a webhook, or null when the signature is wrong. The body must be the exact bytes LiveKit sent. */
  async verifyWebhook(
    authorization: string | undefined,
    body: Buffer,
  ): Promise<LiveKitEvent | null> {
    if (!this.enabled || !authorization) return null;
    try {
      const { payload } = await jwtVerify(authorization.replace(/^Bearer\s+/i, ''), this.key, {
        issuer: this.env.LIVEKIT_API_KEY,
        algorithms: ['HS256'],
      });
      const expected = Buffer.from(String(payload['sha256'] ?? ''), 'base64');
      const actual = createHash('sha256').update(body).digest();
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
      const event = JSON.parse(body.toString('utf8')) as LiveKitEvent;
      return typeof event?.event === 'string' ? event : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- room API

  private async adminToken(room: string): Promise<string> {
    return new SignJWT({ video: { roomAdmin: true, roomList: true, room } })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.env.LIVEKIT_API_KEY ?? '')
      .setExpirationTime('1m')
      .sign(this.key);
  }

  /** One call of LiveKit's room service. A 404 answer ("no such room or participant") is a result, anything else that fails throws a 503. */
  private async call<T>(
    method: string,
    room: string,
    body: Record<string, unknown>,
  ): Promise<T | null> {
    if (!this.enabled) throw new ServiceUnavailableException('voice_unavailable');
    let response: Response;
    try {
      response = await fetch(`${this.apiBase}/twirp/livekit.RoomService/${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${await this.adminToken(room)}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      this.log.warn(`${method} failed: ${e instanceof Error ? e.message : e}`);
      throw new ServiceUnavailableException('voice_unavailable');
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      this.log.warn(`${method} answered ${response.status}`);
      throw new ServiceUnavailableException('voice_unavailable');
    }
    return (await response.json().catch(() => ({}))) as T;
  }

  /** Takes the person out of the room. True when they were there. */
  async removeParticipant(room: string, identity: string): Promise<boolean> {
    return (await this.call('RemoveParticipant', room, { room, identity })) !== null;
  }

  /** Closes the room: everybody in it is disconnected. */
  async deleteRoom(room: string): Promise<void> {
    await this.call('DeleteRoom', room, { room });
  }

  /** Names (our channel ids) of the rooms that have somebody in them. */
  async listRooms(): Promise<string[]> {
    const answer = await this.call<{ rooms?: { name?: string }[] }>('ListRooms', '', {});
    return (answer?.rooms ?? []).map((r) => r.name ?? '').filter(Boolean);
  }

  async listParticipants(room: string): Promise<LiveKitParticipant[]> {
    const answer = await this.call<{ participants?: LiveKitParticipant[] }>(
      'ListParticipants',
      room,
      { room },
    );
    return (answer?.participants ?? []).map((p) => ({ ...p, tracks: p.tracks ?? [] }));
  }

  /** Changes what a connected person may publish (and the attributes the others see). */
  async updateParticipant(
    room: string,
    identity: string,
    sources: VoiceSource[],
    attributes?: Record<string, string>,
  ): Promise<void> {
    await this.call('UpdateParticipant', room, {
      room,
      identity,
      permission: {
        canSubscribe: true,
        canPublish: sources.length > 0,
        canPublishData: false,
        canPublishSources: sources.map((s) => SOURCE_ENUM[s]),
      },
      ...(attributes ? { attributes } : {}),
    });
  }

  /** Switches the person's published tracks of this source off (or on, when the person allows it). */
  async muteTracks(
    room: string,
    identity: string,
    source: 'MICROPHONE',
    muted: boolean,
  ): Promise<void> {
    const person = (await this.listParticipants(room)).find((p) => p.identity === identity);
    for (const t of person?.tracks ?? []) {
      if (t.source !== source || t.muted === muted) continue;
      await this.call('MutePublishedTrack', room, { room, identity, trackSid: t.sid, muted });
    }
  }
}
