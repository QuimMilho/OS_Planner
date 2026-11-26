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

const Id = () => Param('id', { schema: idSchema });

/** Channels and categories of a team or project, and what a person has read in them. */
@Controller()
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get('spaces/:id/channels')
  list(@CurrentUser() u: AuthUser, @Id() spaceId: string): Promise<ChannelDto[]> {
    return this.channels.list(u.id, spaceId);
  }

  @Post('spaces/:id/channels')
  create(
    @CurrentUser() u: AuthUser,
    @Id() spaceId: string,
    @Body({ schema: createChannelSchema }) body: CreateChannelInput,
  ): Promise<ChannelDto> {
    return this.channels.create(u.id, spaceId, body);
  }

  @HttpCode(204)
  @Put('spaces/:id/channels/order')
  async reorder(
    @CurrentUser() u: AuthUser,
    @Id() spaceId: string,
    @Body({ schema: channelOrderSchema }) body: ChannelOrderInput,
  ): Promise<void> {
    await this.channels.reorder(u.id, spaceId, body);
  }

  /** Every channel of the team and its projects that the person can see (what the sidebar lists). */
  @Get('teams/:id/channels')
  teamChannels(@CurrentUser() u: AuthUser, @Id() teamId: string): Promise<ChannelDto[]> {
    return this.channels.listTeam(u.id, teamId);
  }

  @Get('teams/:id/unread')
  teamUnread(@CurrentUser() u: AuthUser, @Id() teamId: string): Promise<UnreadDto[]> {
    return this.channels.unreadTeam(u.id, teamId);
  }

  @Get('spaces/:id/unread')
  unread(@CurrentUser() u: AuthUser, @Id() spaceId: string): Promise<UnreadDto[]> {
    return this.channels.unread(u.id, spaceId);
  }

  @Get('channels/:id')
  one(@CurrentUser() u: AuthUser, @Id() id: string): Promise<ChannelDto> {
    return this.channels.get(u.id, id);
  }

  @Patch('channels/:id')
  update(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateChannelSchema }) body: UpdateChannelInput,
  ): Promise<ChannelDto> {
    return this.channels.update(u.id, id, body);
  }

  @HttpCode(204)
  @Delete('channels/:id')
  async remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.channels.remove(u.id, id);
  }

  @HttpCode(204)
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

  @Get('channels/:id/pins')
  pins(@CurrentUser() u: AuthUser, @Id() id: string): Promise<MessageDto[]> {
    return this.messages.pins(u.id, id);
  }

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

  @Patch('messages/:id')
  edit(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: editMessageSchema }) body: EditMessageInput,
  ): Promise<MessageDto> {
    return this.messages.edit(u.id, id, body);
  }

  @HttpCode(204)
  @Delete('messages/:id')
  async remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.messages.remove(u.id, id);
  }

  @HttpCode(204)
  @Put('messages/:id/reactions/:emoji')
  async react(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Param('emoji', { schema: emojiSchema }) emoji: string,
  ): Promise<void> {
    await this.messages.react(u.id, id, emoji, true);
  }

  @HttpCode(204)
  @Delete('messages/:id/reactions/:emoji')
  async unreact(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Param('emoji', { schema: emojiSchema }) emoji: string,
  ): Promise<void> {
    await this.messages.react(u.id, id, emoji, false);
  }

  @Put('messages/:id/pin')
  pin(@CurrentUser() u: AuthUser, @Id() id: string): Promise<MessageDto> {
    return this.messages.pin(u.id, id, true);
  }

  @Delete('messages/:id/pin')
  unpin(@CurrentUser() u: AuthUser, @Id() id: string): Promise<MessageDto> {
    return this.messages.pin(u.id, id, false);
  }
}

@Controller()
export class ThreadsController {
  constructor(private readonly threads: ThreadsService) {}

  @Post('messages/:id/thread')
  create(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: createThreadSchema }) body: CreateThreadInput,
  ): Promise<ThreadSummaryDto> {
    return this.threads.create(u.id, id, body);
  }

  @Get('threads/:id/messages')
  messages(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Query({ schema: listThreadMessagesSchema }) q: z.infer<typeof listThreadMessagesSchema>,
  ): Promise<ThreadPageDto> {
    return this.threads.messages(u.id, id, q);
  }

  @Patch('threads/:id')
  update(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Body({ schema: updateThreadSchema }) body: UpdateThreadInput,
  ): Promise<ThreadSummaryDto> {
    return this.threads.update(u.id, id, body);
  }
}
