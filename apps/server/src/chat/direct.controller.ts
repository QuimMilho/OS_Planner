import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  idSchema,
  type BlockDto,
  type DmDto,
  type DmPersonDto,
  type StartDmInput,
} from '@os-planner/shared';
import { dmPeopleQuerySchema, dmQuerySchema, startDmSchema } from '@os-planner/shared/chat';
import type { z } from 'zod';
import { CurrentUser, RequireVerified, type AuthUser } from '../common/auth.decorators.js';
import { DirectService } from './direct.service.js';
import { Authz } from '../common/authz.js';

const Id = () => Param('id', { schema: idSchema });

/**
 * Direct messages. Only the conversation itself is managed here (list, start, close); the messages in it are read and
 * written with the ordinary chat endpoints, using the conversation's `channelId`.
 */
@Controller()
export class DirectController {
  constructor(private readonly direct: DirectService) {}

  @Authz({ scope: 'self' })
  @Get('dms')
  list(
    @CurrentUser() u: AuthUser,
    @Query({ schema: dmQuerySchema }) q: z.infer<typeof dmQuerySchema>,
  ): Promise<DmDto[]> {
    return this.direct.list(u.id, q.closed);
  }

  /** People from the person's teams to start a conversation with. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Authz({ scope: 'self' })
  @Get('dms/people')
  people(
    @CurrentUser() u: AuthUser,
    @Query({ schema: dmPeopleQuerySchema }) q: z.infer<typeof dmPeopleQuerySchema>,
  ): Promise<DmPersonDto[]> {
    return this.direct.people(u.id, q.q);
  }

  /** The conversation with that person, made if needed. A refusal never says why: `403 dm_not_allowed`. */
  @RequireVerified()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Authz({ scope: 'self', verified: true, note: 'only with somebody who shares a team and allows it: 403 dm_not_allowed, never why' })
  @Post('dms')
  start(
    @CurrentUser() u: AuthUser,
    @Body({ schema: startDmSchema }) body: StartDmInput,
  ): Promise<DmDto> {
    return this.direct.start(u.id, body.userId);
  }

  @Authz({ scope: 'dm' })
  @Get('dms/:id')
  one(@CurrentUser() u: AuthUser, @Id() id: string): Promise<DmDto> {
    return this.direct.get(u.id, id);
  }

  @HttpCode(200)
  @Authz({ scope: 'dm' })
  @Post('dms/:id/close')
  close(@CurrentUser() u: AuthUser, @Id() id: string): Promise<DmDto> {
    return this.direct.close(u.id, id, true);
  }

  @HttpCode(200)
  @Authz({ scope: 'dm' })
  @Post('dms/:id/open')
  open(@CurrentUser() u: AuthUser, @Id() id: string): Promise<DmDto> {
    return this.direct.close(u.id, id, false);
  }

  @Authz({ scope: 'self' })
  @Get('blocks')
  blocks(@CurrentUser() u: AuthUser): Promise<BlockDto[]> {
    return this.direct.blocks(u.id);
  }

  @HttpCode(204)
  @Authz({ scope: 'self' })
  @Put('blocks/:userId')
  async block(
    @CurrentUser() u: AuthUser,
    @Param('userId', { schema: idSchema }) userId: string,
  ): Promise<void> {
    await this.direct.block(u.id, userId, true);
  }

  @HttpCode(204)
  @Authz({ scope: 'self' })
  @Delete('blocks/:userId')
  async unblock(
    @CurrentUser() u: AuthUser,
    @Param('userId', { schema: idSchema }) userId: string,
  ): Promise<void> {
    await this.direct.block(u.id, userId, false);
  }
}
