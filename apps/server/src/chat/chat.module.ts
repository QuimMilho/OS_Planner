import { Module, type OnModuleInit } from '@nestjs/common';
import { MulterConfig } from '../media/media.controller.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PermissionService } from '../spaces/permission.service.js';
import { RoomAuthorizer } from '../realtime/room-authorizer.js';
import { AttachmentsService } from './attachments.service.js';
import { ChannelsService } from './channels.service.js';
import { ChatEvents } from './chat-events.js';
import { ChannelsController, MessagesController, ThreadsController } from './chat.controller.js';
import { DirectAccess } from './direct-access.js';
import { DirectController } from './direct.controller.js';
import { DirectService } from './direct.service.js';
import { ChatMaintenance } from './chat.maintenance.js';
import { MessageView } from './message-view.js';
import { MessagesService } from './messages.service.js';
import { ThreadsService } from './threads.service.js';

/** Text channels, messages, attachments, reactions, pins and threads. Exports what other features need (DMs reuse the engine). */
@Module({
  imports: [MulterConfig, NotificationsModule],
  controllers: [ChannelsController, MessagesController, ThreadsController, DirectController],
  providers: [
    ChatEvents,
    MessageView,
    ChannelsService,
    MessagesService,
    ThreadsService,
    AttachmentsService,
    ChatMaintenance,
    DirectAccess,
    DirectService,
  ],
  exports: [ChannelsService, MessagesService, ThreadsService, ChatEvents, MessageView, DirectService, DirectAccess],
})
export class ChatModule implements OnModuleInit {
  constructor(
    private readonly rooms: RoomAuthorizer,
    private readonly perms: PermissionService,
    private readonly channels: ChannelsService,
    private readonly threads: ThreadsService,
    private readonly direct: DirectAccess,
  ) {}

  /** Who may be in the room of a channel or a thread: whoever can see the channel (checked again on every permission change). */
  onModuleInit(): void {
    this.rooms.register('channel', async (userId, id) => {
      // A conversation's room is for its two people (blocked or not: the history stays readable).
      if (await this.direct.participates(userId, id)) return true;
      const access = await this.perms.channelAccess(userId, id);
      if (!access || access.channel.kind !== 'text') return false;
      await this.channels.touch(userId, id); // joining is how a person without READ_MESSAGE_HISTORY starts seeing messages
      return true;
    });
    this.rooms.register('thread', (userId, id) => this.threads.canJoin(userId, id));
  }
}
