import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  acceptInviteSchema,
  banSchema,
  createInviteSchema,
  directoryQuerySchema,
  idSchema,
  inviteTokenQuerySchema,
  joinTeamSchema,
  transferOwnershipSchema,
  type AcceptedInviteDto,
  type AcceptInviteInput,
  type BanDto,
  type BanInput,
  type CreatedInviteDto,
  type CreateInviteInput,
  type DirectoryPageDto,
  type DirectoryQuery,
  type DirectoryTeamDto,
  type InviteDto,
  type InvitePreviewDto,
  type JoinRequestDto,
  type JoinResultDto,
  type JoinTeamInput,
  type TransferOwnershipInput,
} from '@os-planner/shared';
import type { z } from 'zod';
import { CurrentUser, Public, type AuthUser } from '../common/auth.decorators.js';
import { InvitesService } from './invites.service.js';
import { JoiningService } from './joining.service.js';
import { MembershipService } from './membership.service.js';
import { Authz } from '../common/authz.js';

const Id = () => Param('id', { schema: idSchema });
const UserParam = () => Param('userId', { schema: idSchema });
const RequestParam = () => Param('rid', { schema: idSchema });

/** Invitations. Managing them needs CREATE_INVITES (404 for people outside the team, 403 for members without it). */
@Controller()
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Authz({ scope: 'team', needs: ['CREATE_INVITES'], note: 'handing out roles needs MANAGE_ROLES, a project MANAGE_PROJECTS' })
  @Post('teams/:id/invites')
  create(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: createInviteSchema }) body: CreateInviteInput,
  ): Promise<CreatedInviteDto> {
    return this.invites.create(u.id, id, body);
  }

  @Authz({ scope: 'team', needs: ['CREATE_INVITES'] })
  @Get('teams/:id/invites')
  list(@CurrentUser() u: AuthUser, @Id() id: string): Promise<InviteDto[]> {
    return this.invites.list(u.id, id);
  }

  @HttpCode(204)
  @Authz({ scope: 'team', needs: ['CREATE_INVITES'] })
  @Delete('invites/:id')
  async revoke(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.invites.revoke(u.id, id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Authz({ scope: 'team', needs: ['CREATE_INVITES'] })
  @Post('invites/:id/resend')
  resend(@CurrentUser() u: AuthUser, @Id() id: string): Promise<InviteDto> {
    return this.invites.resend(u.id, id);
  }

  /** For visitors who are not signed in yet: the team's name, icon and size, nothing else. */
  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Header('Cache-Control', 'no-store')
  @Authz({ scope: 'secret' })
  @Get('invites/preview')
  preview(
    @Query({ schema: inviteTokenQuerySchema }) q: z.infer<typeof inviteTokenQuerySchema>,
  ): Promise<InvitePreviewDto> {
    return this.invites.preview(q.token);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Authz({ scope: 'self', verified: true, note: 'the invite token in the body is the key' })
  @Post('invites/accept')
  accept(
    @CurrentUser() u: AuthUser,
    @Body({ schema: acceptInviteSchema }) body: AcceptInviteInput,
  ): Promise<AcceptedInviteDto> {
    return this.invites.accept(u.id, body.token);
  }
}

/** The public directory, joining, and deciding on requests. */
@Controller()
export class JoiningController {
  constructor(private readonly joining: JoiningService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Authz({ scope: 'self' })
  @Get('directory')
  directory(
    @CurrentUser() u: AuthUser,
    @Query({ schema: directoryQuerySchema }) q: DirectoryQuery,
  ): Promise<DirectoryPageDto> {
    return this.joining.directory(u.id, q);
  }

  @Authz({ scope: 'self' })
  @Get('directory/:slug')
  directoryOne(@CurrentUser() u: AuthUser, @Param('slug') slug: string): Promise<DirectoryTeamDto> {
    return this.joining.directoryOne(u.id, slug);
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Authz({ scope: 'self', verified: true, note: 'teams listed in the directory only (404 for any other); banned people are refused' })
  @Post('teams/:id/join')
  join(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: joinTeamSchema }) body: JoinTeamInput,
  ): Promise<JoinResultDto> {
    return this.joining.join(u.id, id, body.message);
  }

  @HttpCode(204)
  @Authz({ scope: 'self', note: "the caller's own request" })
  @Delete('teams/:id/join-request')
  async withdraw(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.joining.withdraw(u.id, id);
  }

  @Authz({ scope: 'team', needs: ['MANAGE_MEMBERS'] })
  @Get('teams/:id/join-requests')
  requests(@CurrentUser() u: AuthUser, @Id() id: string): Promise<JoinRequestDto[]> {
    return this.joining.requests(u.id, id);
  }

  @HttpCode(204)
  @Authz({ scope: 'team', needs: ['MANAGE_MEMBERS'] })
  @Post('teams/:id/join-requests/:rid/approve')
  async approve(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @RequestParam() rid: string,
  ): Promise<void> {
    await this.joining.decide(u.id, id, rid, true);
  }

  @HttpCode(204)
  @Authz({ scope: 'team', needs: ['MANAGE_MEMBERS'] })
  @Post('teams/:id/join-requests/:rid/deny')
  async deny(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @RequestParam() rid: string,
  ): Promise<void> {
    await this.joining.decide(u.id, id, rid, false);
  }
}

/** Bans and ownership. */
@Controller('teams')
export class MembershipController {
  constructor(private readonly membership: MembershipService) {}

  @Authz({ scope: 'team', needs: ['MANAGE_MEMBERS'] })
  @Get(':id/bans')
  bans(@CurrentUser() u: AuthUser, @Id() id: string): Promise<BanDto[]> {
    return this.membership.bans(u.id, id);
  }

  @HttpCode(204)
  @Authz({ scope: 'team', needs: ['MANAGE_MEMBERS'], note: 'only people ranked below the caller' })
  @Put(':id/bans/:userId')
  async ban(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @UserParam() userId: string,
    @Body({ schema: banSchema }) body: BanInput,
  ): Promise<void> {
    await this.membership.ban(u.id, id, userId, body.reason);
  }

  @HttpCode(204)
  @Authz({ scope: 'team', needs: ['MANAGE_MEMBERS'] })
  @Delete(':id/bans/:userId')
  async unban(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @UserParam() userId: string,
  ): Promise<void> {
    await this.membership.unban(u.id, id, userId);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(204)
  @Authz({ scope: 'team', ownerOnly: true, note: "with the owner's password" })
  @Post(':id/transfer-ownership')
  async transfer(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: transferOwnershipSchema }) body: TransferOwnershipInput,
  ): Promise<void> {
    await this.membership.transferOwnership(u.id, id, body.userId, body.password);
  }
}
