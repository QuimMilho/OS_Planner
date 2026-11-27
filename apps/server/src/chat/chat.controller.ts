import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  idSchema,
  type AttachmentDto,
  type AttachmentFields,
  type ChannelDto,
  type ChannelOrderInput,
  type CreateChannelInput,
  type CreateThreadInput,
  type EditMessageInput,
  type ListMessagesQuery,
  type MessageDto,
  type MessagePageDto,
  type SendMessageInput,
  type ThreadPageDto,
  type ThreadSummaryDto,
  type UnreadDto,
  type UpdateChannelInput,
  type UpdateThreadInput,
} from '@os-planner/shared';
import {
  attachmentFieldsSchema,
  channelOrderSchema,
  createChannelSchema,
  createThreadSchema,
  editMessageSchema,
  emojiSchema,
  listMessagesSchema,
  listThreadMessagesSchema,
  markReadSchema,
  searchMessagesSchema,
  sendMessageSchema,
  updateChannelSchema,
  updateThreadSchema,
} from '@os-planner/shared/chat';
import type { z } from 'zod';
import { CurrentUser, RequireVerified, type AuthUser } from '../common/auth.decorators.js';
import type { UploadedTempFile } from '../media/media.service.js';
import { AttachmentsService } from './attachments.service.js';
import { ChannelsService } from './channels.service.js';
import { MessagesService } from './messages.service.js';
import { ThreadsService } from './threads.service.js';
import { Authz } from '../common/authz.js';

const Id = () => Param('id', { schema: idSchema });

/** Channels and categories of a team or project, and what a person has read in them. */
@Controller()
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Authz({ scope: 'space', note: 'only the channels the person can see' })
  @Get('spaces/:id/channels')
  list(@CurrentUser() u: AuthUser, @Id() spaceId: string): Promise<ChannelDto[]> {
    return this.channels.list(u.id, spaceId);
  }

  @Authz({ scope: 'space', needs: ['MANAGE_CHANNELS'] })
  @Post('spaces/:id/channels')
  create(
    @CurrentUser() u: AuthUser,
    @Id() spaceId: string,
    @Body({ schema: createChannelSchema }) body: CreateChannelInput,
  ): Promise<ChannelDto> {
    return this.channels.create(u.id, spaceId, body);
  }

  @HttpCode(204)
  @Authz({ scope: 'space', needs: ['MANAGE_CHANNELS'] })
  @Put('spaces/:id/channels/order')
  async reorder(
    @CurrentUser() u: AuthUser,
    @Id() spaceId: string,
    @Body({ schema: channelOrderSchema }) body: ChannelOrderInput,
  ): Promise<void> {
    await this.channels.reorder(u.id, spaceId, body);
  }

  /** Every channel of the team and its projects that the person can see (what the sidebar lists). */
  @Authz({ scope: 'team', note: 'only the channels the person can see' })
  @Get('teams/:id/channels')
  teamChannels(@CurrentUser() u: AuthUser, @Id() teamId: string): Promise<ChannelDto[]> {
    return this.channels.listTeam(u.id, teamId);
  }

  @Authz({ scope: 'team' })
  @Get('teams/:id/unread')
  teamUnread(@CurrentUser() u: AuthUser, @Id() teamId: string): Promise<UnreadDto[]> {
    return this.channels.unreadTeam(u.id, teamId);
  }

  @Authz({ scope: 'space' })
  @Get('spaces/:id/unread')
  unread(@CurrentUser() u: AuthUser, @Id() spaceId: string): Promise<UnreadDto[]> {
    return this.channels.unread(u.id, spaceId);
  }

  @Authz({ scope: 'channel' })
  @Get('channels/:id')
  one(@CurrentUser() u: AuthUser, @Id() id: string): Promise<ChannelDto> {
    return this.channels.get(u.id, id);
  }

  @Authz({ scope: 'channel', needs: ['MANAGE_CHANNELS'] })
  @Patch('channels/:id')
  update(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateChannelSchema }) body: UpdateChannelInput,
  ): Promise<ChannelDto> {
    return this.channels.update(u.id, id, body);
  }

  @HttpCode(204)
  @Authz({ scope: 'channel', needs: ['MANAGE_CHANNELS'] })
  @Delete('channels/:id')
  async remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.channels.remove(u.id, id);
  }

  @HttpCode(204)
  @Authz({ scope: 'channel' })
  @Put('channels/:id/read')
  async read(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: markReadSchema }) body: z.infer<typeof markReadSchema>,
  ): Promise<void> {
    await this.channels.markRead(u.id, id, body.messageId);
  }
}

/** Messages, attachments, reactions and pins. A channel the person cannot see answers 404 to every one of these. */
@Controller()
export class MessagesController {
  constructor(
    private readonly messages: MessagesService,
    private readonly attachments: AttachmentsService,
  ) {}

  @Authz({ scope: 'channel', needs: ['READ_MESSAGE_HISTORY'] })
  @Get('channels/:id/messages')
  list(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Query({ schema: listMessagesSchema }) q: ListMessagesQuery,
  ): Promise<MessagePageDto> {
    return this.messages.list(u.id, id, q);
  }

  /** 201 for a new message, 200 when the same id was sent before (a retry): the answer is the same message either way. */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Authz({ scope: 'channel', needs: ['SEND_MESSAGES'], note: 'SEND_IN_THREADS in a thread, ATTACH_FILES with files' })
  @Post('channels/:id/messages')
  async send(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: sendMessageSchema }) body: SendMessageInput,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MessageDto> {
    const sent = await this.messages.send(u.id, id, body);
    res.status(sent.created ? 201 : 200);
    return sent.message;
  }

  @Authz({ scope: 'channel', needs: ['READ_MESSAGE_HISTORY'] })
  @Get('channels/:id/pins')
  pins(@CurrentUser() u: AuthUser, @Id() id: string): Promise<MessageDto[]> {
    return this.messages.pins(u.id, id);
  }

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Authz({ scope: 'channel', needs: ['READ_MESSAGE_HISTORY'] })
  @Get('channels/:id/search')
  search(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Query({ schema: searchMessagesSchema }) q: z.infer<typeof searchMessagesSchema>,
  ): Promise<MessageDto[]> {
    return this.messages.search(u.id, id, q.q);
  }

  @RequireVerified()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Authz({ scope: 'channel', needs: ['ATTACH_FILES'], verified: true })
  @Post('channels/:id/attachments')
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @UploadedFile() file: UploadedTempFile | undefined,
    @Body({ schema: attachmentFieldsSchema }) fields: AttachmentFields,
  ): Promise<AttachmentDto> {
    if (!file) throw new UnprocessableEntityException('file_required');
    return this.attachments.upload(u.id, id, file, {
      ...fields,
      name: fields.name ?? file.originalname,
    });
  }

  @Authz({ scope: 'channel', author: 'only' })
  @Patch('messages/:id')
  edit(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: editMessageSchema }) body: EditMessageInput,
  ): Promise<MessageDto> {
    return this.messages.edit(u.id, id, body);
  }

  @HttpCode(204)
  @Authz({ scope: 'channel', needs: ['MANAGE_MESSAGES'], author: 'or' })
  @Delete('messages/:id')
  async remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.messages.remove(u.id, id);
  }

  @HttpCode(204)
  @Authz({ scope: 'channel', needs: ['ADD_REACTIONS'] })
  @Put('messages/:id/reactions/:emoji')
  async react(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Param('emoji', { schema: emojiSchema }) emoji: string,
  ): Promise<void> {
    await this.messages.react(u.id, id, emoji, true);
  }

  @HttpCode(204)
  @Authz({ scope: 'channel', note: "removes the caller's own reaction" })
  @Delete('messages/:id/reactions/:emoji')
  async unreact(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Param('emoji', { schema: emojiSchema }) emoji: string,
  ): Promise<void> {
    await this.messages.react(u.id, id, emoji, false);
  }

  @Authz({ scope: 'channel', needs: ['MANAGE_MESSAGES'] })
  @Put('messages/:id/pin')
  pin(@CurrentUser() u: AuthUser, @Id() id: string): Promise<MessageDto> {
    return this.messages.pin(u.id, id, true);
  }

  @Authz({ scope: 'channel', needs: ['MANAGE_MESSAGES'] })
  @Delete('messages/:id/pin')
  unpin(@CurrentUser() u: AuthUser, @Id() id: string): Promise<MessageDto> {
    return this.messages.pin(u.id, id, false);
  }
}

@Controller()
export class ThreadsController {
  constructor(private readonly threads: ThreadsService) {}

  @Authz({ scope: 'channel', needs: ['CREATE_THREADS'] })
  @Post('messages/:id/thread')
  create(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: createThreadSchema }) body: CreateThreadInput,
  ): Promise<ThreadSummaryDto> {
    return this.threads.create(u.id, id, body);
  }

  @Authz({ scope: 'channel', needs: ['READ_MESSAGE_HISTORY'] })
  @Get('threads/:id/messages')
  messages(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Query({ schema: listThreadMessagesSchema }) q: z.infer<typeof listThreadMessagesSchema>,
  ): Promise<ThreadPageDto> {
    return this.threads.messages(u.id, id, q);
  }

  @Authz({ scope: 'channel', needs: ['MANAGE_MESSAGES'], author: 'or' })
  @Patch('threads/:id')
  update(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateThreadSchema }) body: UpdateThreadInput,
  ): Promise<ThreadSummaryDto> {
    return this.threads.update(u.id, id, body);
  }
}
