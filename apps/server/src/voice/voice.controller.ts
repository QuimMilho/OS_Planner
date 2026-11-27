import {
  Body,
  Controller,
  Get,
  HttpCode,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  idSchema,
  type FeaturesDto,
  type VoiceChannelStateDto,
  type VoiceMoveInput,
  type VoiceTokenDto,
} from '@os-planner/shared';
import { voiceMoveSchema } from '@os-planner/shared/chat';
import { CurrentUser, Public, type AuthUser } from '../common/auth.decorators.js';
import { ENV, pushEnabled, voiceEnabled, type Env } from '../config/env.js';
import { LiveKitService } from './livekit.service.js';
import { VoiceService } from './voice.service.js';
import { Authz } from '../common/authz.js';

const Id = () => Param('id', { schema: idSchema });
const Target = () => Param('userId', { schema: idSchema });

/** What this instance can do, so the website shows only what works. Nothing secret: the same answer for everybody. */
@Controller('features')
export class FeaturesController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  @Public()
  @Authz({ scope: 'public' })
  @Get()
  features(): FeaturesDto {
    return { voice: voiceEnabled(this.env), push: pushEnabled(this.env), collab: true };
  }
}

/** Joining voice channels, who is in them, and moderating them. */
@Controller()
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @HttpCode(200)
  @Authz({ scope: 'channel', needs: ['CONNECT'], note: '404 when voice is off; 409 channel_full' })
  @Post('channels/:id/voice/token')
  token(@CurrentUser() u: AuthUser, @Id() id: string): Promise<VoiceTokenDto> {
    return this.voice.token(u.id, id);
  }

  @Authz({ scope: 'channel' })
  @Get('channels/:id/voice')
  channel(@CurrentUser() u: AuthUser, @Id() id: string): Promise<VoiceChannelStateDto> {
    return this.voice.channelState(u.id, id);
  }

  /** Who is in each voice channel of the team and its projects that the person can see. */
  @Authz({ scope: 'team' })
  @Get('teams/:id/voice')
  team(@CurrentUser() u: AuthUser, @Id() teamId: string): Promise<VoiceChannelStateDto[]> {
    return this.voice.teamState(u.id, teamId);
  }

  @HttpCode(204)
  @Authz({ scope: 'channel', needs: ['MUTE_MEMBERS'], note: 'only people ranked below the caller' })
  @Post('channels/:id/voice/participants/:userId/mute')
  async mute(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Target() target: string,
  ): Promise<void> {
    await this.voice.moderate(u.id, id, target, 'mute');
  }

  @HttpCode(204)
  @Authz({ scope: 'channel', needs: ['MUTE_MEMBERS'] })
  @Post('channels/:id/voice/participants/:userId/unmute')
  async unmute(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Target() target: string,
  ): Promise<void> {
    await this.voice.moderate(u.id, id, target, 'unmute');
  }

  @HttpCode(204)
  @Authz({ scope: 'channel', needs: ['MOVE_MEMBERS'], note: 'also in the destination' })
  @Post('channels/:id/voice/participants/:userId/move')
  async move(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Target() target: string,
    @Body({ schema: voiceMoveSchema }) body: VoiceMoveInput,
  ): Promise<void> {
    await this.voice.moderate(u.id, id, target, 'move', body.toChannelId);
  }

  @HttpCode(204)
  @Authz({ scope: 'channel', anyOf: ['MOVE_MEMBERS', 'MANAGE_CHANNELS'] })
  @Post('channels/:id/voice/participants/:userId/disconnect')
  async disconnect(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Target() target: string,
  ): Promise<void> {
    await this.voice.moderate(u.id, id, target, 'disconnect');
  }
}

/**
 * The media server's webhook. Not signed in: LiveKit proves itself with a JWT (signed with the API secret) that also carries the
 * hash of the body, so the exact bytes are needed (the route is read raw, see app.setup). Anything that does not verify is a 401
 * and nothing else is said.
 */
@Controller('voice')
export class VoiceWebhookController {
  constructor(
    private readonly livekit: LiveKitService,
    private readonly voice: VoiceService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @HttpCode(200)
  @Authz({ scope: 'webhook' })
  @Post('webhook')
  async webhook(
    @Headers('authorization') authorization: string | undefined,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const event = await this.livekit.verifyWebhook(authorization, body);
    if (!event) throw new UnauthorizedException('invalid_signature');
    await this.voice.onWebhook(event);
    return { ok: true };
  }
}
