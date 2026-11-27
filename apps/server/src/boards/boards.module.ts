import { Module, type OnModuleInit } from '@nestjs/common';
import { MulterConfig } from '../media/media.controller.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RoomAuthorizer } from '../realtime/room-authorizer.js';
import { PermissionService } from '../spaces/permission.service.js';
import { BoardEvents } from './board-events.js';
import { BoardsController, LabelsController, TasksController } from './boards.controller.js';
import { BoardsMaintenance } from './boards.maintenance.js';
import { BoardsService } from './boards.service.js';
import { LabelsService } from './labels.service.js';
import { TaskAccess } from './task-access.js';
import { TaskAttachmentsService } from './task-attachments.service.js';
import { TaskCommentsService } from './task-comments.service.js';
import { TaskViewsService } from './task-views.service.js';
import { TasksService } from './tasks.service.js';

/** Boards, columns, tasks, labels, comments and files on tasks. Sync (tree module) calls into TasksService for offline operations. */
@Module({
  imports: [MulterConfig, NotificationsModule],
  controllers: [BoardsController, LabelsController, TasksController],
  providers: [BoardEvents, TaskAccess, LabelsService, BoardsService, TasksService, TaskCommentsService, TaskAttachmentsService, TaskViewsService, BoardsMaintenance],
  exports: [BoardsService, TasksService, LabelsService, TaskAccess],
})
export class BoardsModule implements OnModuleInit {
  constructor(
    private readonly rooms: RoomAuthorizer,
    private readonly perms: PermissionService,
  ) {}

  /** Who may be in the room of a board: whoever can see it (checked again whenever permissions change). */
  onModuleInit(): void {
    this.rooms.register('board', async (userId, id) => {
      const access = await this.perms.boardAccess(userId, id);
      return !!access && !access.board.deletedAt;
    });
  }
}
