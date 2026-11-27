import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, UnprocessableEntityException, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import {
  idSchema,
  type BoardDetailDto,
  type BoardDto,
  type BoardPermissionsDto,
  type ColumnDto,
  type CreateBoardInput,
  type CreateColumnInput,
  type CreateCommentInput,
  type CreateLabelInput,
  type AddChecklistItemInput,
  type CreateTaskInput,
  type DeleteColumnInput,
  type EditChecklistItemInput,
  type DuplicateBoardInput,
  type LabelDto,
  type MoveTaskInput,
  type MyTaskDto,
  type TaskAttachmentDto,
  type TaskAttachmentFields,
  type TaskCommentDto,
  type TaskDetailDto,
  type TaskDto,
  type UpdateBoardInput,
  type UpdateColumnInput,
  type UpdateCommentInput,
  type UpdateLabelInput,
  type UpdateTaskInput,
} from '@os-planner/shared';
import {
  activityQuerySchema,
  addChecklistItemSchema,
  createBoardSchema,
  createColumnSchema,
  createCommentSchema,
  createLabelSchema,
  createTaskSchema,
  deleteColumnSchema,
  duplicateBoardSchema,
  editChecklistItemSchema,
  moveTaskSchema,
  taskAttachmentFieldsSchema,
  taskQuerySchema,
  updateBoardSchema,
  updateColumnSchema,
  updateCommentSchema,
  updateLabelSchema,
  updateTaskSchema,
  type TaskQuery,
} from '@os-planner/shared/boards';
import type { z } from 'zod';
import { CurrentUser, RequireVerified, type AuthUser } from '../common/auth.decorators.js';
import type { UploadedTempFile } from '../media/media.service.js';
import { BoardsService } from './boards.service.js';
import { LabelsService } from './labels.service.js';
import { TaskAttachmentsService } from './task-attachments.service.js';
import { TaskCommentsService } from './task-comments.service.js';
import { TaskViewsService } from './task-views.service.js';
import { TasksService } from './tasks.service.js';
import { Authz } from '../common/authz.js';

const Id = () => Param('id', { schema: idSchema });

/** Boards and their columns. A board the person cannot see answers 404 to all of these. */
@Controller()
export class BoardsController {
  constructor(
    private readonly boards: BoardsService,
    private readonly views: TaskViewsService,
  ) {}

  @Authz({ scope: 'self' })
  @Get('board-permissions')
  permissions(@CurrentUser() u: AuthUser): Promise<BoardPermissionsDto> {
    return this.views.permissions(u.id);
  }

  @Authz({ scope: 'board', note: 'the boards of the space the person can see' })
  @Get('spaces/:id/boards')
  list(@CurrentUser() u: AuthUser, @Id() spaceId: string): Promise<BoardDto[]> {
    return this.boards.list(u.id, spaceId);
  }

  @Authz({ scope: 'board', needs: ['MANAGE_BOARDS'] })
  @Post('spaces/:id/boards')
  create(@CurrentUser() u: AuthUser, @Id() spaceId: string, @Body({ schema: createBoardSchema }) body: CreateBoardInput): Promise<BoardDto> {
    return this.boards.create(u.id, spaceId, body);
  }

  @Authz({ scope: 'board' })
  @Get('boards/:id')
  one(@CurrentUser() u: AuthUser, @Id() id: string): Promise<BoardDetailDto> {
    return this.boards.detail(u.id, id);
  }

  @Authz({ scope: 'board', needs: ['MANAGE_BOARDS'] })
  @Patch('boards/:id')
  update(@CurrentUser() u: AuthUser, @Id() id: string, @Body({ schema: updateBoardSchema }) body: UpdateBoardInput): Promise<BoardDto> {
    return this.boards.update(u.id, id, body);
  }

  @HttpCode(204)
  @Authz({ scope: 'board', needs: ['MANAGE_BOARDS'] })
  @Delete('boards/:id')
  async remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.boards.remove(u.id, id);
  }

  @HttpCode(200)
  @Authz({ scope: 'board', needs: ['MANAGE_BOARDS'] })
  @Post('boards/:id/restore')
  restore(@CurrentUser() u: AuthUser, @Id() id: string): Promise<BoardDto> {
    return this.boards.restore(u.id, id);
  }

  @Authz({ scope: 'board', needs: ['MANAGE_BOARDS'], note: 'copying tasks needs CREATE_TASKS' })
  @Post('boards/:id/duplicate')
  duplicate(@CurrentUser() u: AuthUser, @Id() id: string, @Body({ schema: duplicateBoardSchema }) body: DuplicateBoardInput): Promise<BoardDto> {
    return this.boards.duplicate(u.id, id, body);
  }

  @Authz({ scope: 'board', needs: ['MANAGE_BOARDS'] })
  @Post('boards/:id/columns')
  createColumn(@CurrentUser() u: AuthUser, @Id() id: string, @Body({ schema: createColumnSchema }) body: CreateColumnInput): Promise<ColumnDto> {
    return this.boards.createColumn(u.id, id, body);
  }

  @Authz({ scope: 'board', needs: ['MANAGE_BOARDS'] })
  @Patch('columns/:id')
  updateColumn(@CurrentUser() u: AuthUser, @Id() id: string, @Body({ schema: updateColumnSchema }) body: UpdateColumnInput): Promise<ColumnDto> {
    return this.boards.updateColumn(u.id, id, body);
  }

  /** Deleting a column moves its tasks to the column named in the body (`moveTo`). */
  @HttpCode(204)
  @Authz({ scope: 'board', needs: ['MANAGE_BOARDS'] })
  @Delete('columns/:id')
  async removeColumn(@CurrentUser() u: AuthUser, @Id() id: string, @Body({ schema: deleteColumnSchema }) body: DeleteColumnInput): Promise<void> {
    await this.boards.removeColumn(u.id, id, body ?? {});
  }
}

/** Labels of a team, a project or a personal space. */
@Controller()
export class LabelsController {
  constructor(private readonly labels: LabelsService) {}

  @Authz({ scope: 'board' })
  @Get('spaces/:id/labels')
  list(@CurrentUser() u: AuthUser, @Id() spaceId: string): Promise<LabelDto[]> {
    return this.labels.list(u.id, spaceId);
  }

  @Authz({ scope: 'board', needs: ['MANAGE_LABELS'] })
  @Post('spaces/:id/labels')
  create(@CurrentUser() u: AuthUser, @Id() spaceId: string, @Body({ schema: createLabelSchema }) body: CreateLabelInput): Promise<LabelDto> {
    return this.labels.create(u.id, spaceId, body);
  }

  @Authz({ scope: 'board', needs: ['MANAGE_LABELS'] })
  @Patch('labels/:id')
  update(@CurrentUser() u: AuthUser, @Id() id: string, @Body({ schema: updateLabelSchema }) body: UpdateLabelInput): Promise<LabelDto> {
    return this.labels.update(u.id, id, body);
  }

  @HttpCode(204)
  @Authz({ scope: 'board', needs: ['MANAGE_LABELS'] })
  @Delete('labels/:id')
  async remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.labels.remove(u.id, id);
  }
}

/** Tasks, their people and labels, checklists, comments and files. */
@Controller()
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly comments: TaskCommentsService,
    private readonly files: TaskAttachmentsService,
    private readonly views: TaskViewsService,
  ) {}

  // ---- lists

  @Authz({ scope: 'self' })
  @Get('me/tasks')
  mine(@CurrentUser() u: AuthUser, @Query({ schema: taskQuerySchema }) q: TaskQuery): Promise<MyTaskDto[]> {
    return this.views.mine(u.id, q);
  }

  @Authz({ scope: 'board' })
  @Get('spaces/:id/tasks')
  ofSpace(@CurrentUser() u: AuthUser, @Id() spaceId: string, @Query({ schema: taskQuerySchema }) q: TaskQuery): Promise<MyTaskDto[]> {
    return this.views.ofSpace(u.id, spaceId, q);
  }

  @Authz({ scope: 'board' })
  @Get('boards/:id/trash')
  trash(@CurrentUser() u: AuthUser, @Id() boardId: string): Promise<TaskDto[]> {
    return this.tasks.trash(u.id, boardId);
  }

  // ---- one task

  @Authz({ scope: 'board', needs: ['CREATE_TASKS'], note: 'assigning people needs ASSIGN_TASKS' })
  @Post('boards/:id/tasks')
  create(@CurrentUser() u: AuthUser, @Id() boardId: string, @Body({ schema: createTaskSchema }) body: CreateTaskInput): Promise<TaskDto> {
    return this.tasks.create(u.id, boardId, body);
  }

  @Authz({ scope: 'board' })
  @Get('tasks/:id')
  one(@CurrentUser() u: AuthUser, @Id() id: string): Promise<TaskDetailDto> {
    return this.tasks.detail(u.id, id);
  }

  @Authz({ scope: 'board', needs: ['EDIT_TASKS'], author: 'or', note: 'the maker or an assignee may change title, description, checklist and done' })
  @Patch('tasks/:id')
  update(@CurrentUser() u: AuthUser, @Id() id: string, @Body({ schema: updateTaskSchema }) body: UpdateTaskInput): Promise<TaskDto> {
    return this.tasks.update(u.id, id, body);
  }

  @HttpCode(200)
  @Authz({ scope: 'board', needs: ['EDIT_TASKS'], author: 'or' })
  @Post('tasks/:id/move')
  move(@CurrentUser() u: AuthUser, @Id() id: string, @Body({ schema: moveTaskSchema }) body: MoveTaskInput): Promise<TaskDto> {
    return this.tasks.move(u.id, id, body);
  }

  @HttpCode(204)
  @Authz({ scope: 'board', needs: ['EDIT_TASKS'], author: 'or' })
  @Delete('tasks/:id')
  async remove(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.tasks.remove(u.id, id);
  }

  @HttpCode(200)
  @Authz({ scope: 'board', needs: ['EDIT_TASKS'], author: 'or' })
  @Post('tasks/:id/restore')
  restore(@CurrentUser() u: AuthUser, @Id() id: string): Promise<TaskDto> {
    return this.tasks.restore(u.id, id);
  }

  /** Deletes a trashed task for good. */
  @HttpCode(204)
  @Authz({ scope: 'board', needs: ['EDIT_TASKS'], author: 'or' })
  @Delete('tasks/:id/purge')
  async purge(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.tasks.purge(u.id, id);
  }

  @Authz({ scope: 'board' })
  @Get('tasks/:id/activity')
  activity(@CurrentUser() u: AuthUser, @Id() id: string, @Query({ schema: activityQuerySchema }) q: z.infer<typeof activityQuerySchema>) {
    return this.tasks.activity(u.id, id, q.before, q.limit);
  }

  // ---- people and labels (the same rules as a PATCH with the whole list: these add or remove one)

  @Authz({ scope: 'board', needs: ['ASSIGN_TASKS'] })
  @Put('tasks/:id/assignees/:userId')
  assign(@CurrentUser() u: AuthUser, @Id() id: string, @Param('userId', { schema: idSchema }) userId: string): Promise<TaskDto> {
    return this.tasks.addAssignee(u.id, id, userId);
  }

  @Authz({ scope: 'board', needs: ['ASSIGN_TASKS'] })
  @Delete('tasks/:id/assignees/:userId')
  unassign(@CurrentUser() u: AuthUser, @Id() id: string, @Param('userId', { schema: idSchema }) userId: string): Promise<TaskDto> {
    return this.tasks.removeAssignee(u.id, id, userId);
  }

  @Authz({ scope: 'board', needs: ['EDIT_TASKS'] })
  @Put('tasks/:id/labels/:labelId')
  addLabel(@CurrentUser() u: AuthUser, @Id() id: string, @Param('labelId', { schema: idSchema }) labelId: string): Promise<TaskDto> {
    return this.tasks.addLabel(u.id, id, labelId);
  }

  @Authz({ scope: 'board', needs: ['EDIT_TASKS'] })
  @Delete('tasks/:id/labels/:labelId')
  removeLabel(@CurrentUser() u: AuthUser, @Id() id: string, @Param('labelId', { schema: idSchema }) labelId: string): Promise<TaskDto> {
    return this.tasks.removeLabel(u.id, id, labelId);
  }

  // ---- checklist

  @Authz({ scope: 'board', needs: ['EDIT_TASKS'], author: 'or' })
  @Post('tasks/:id/checklist')
  addItem(@CurrentUser() u: AuthUser, @Id() id: string, @Body({ schema: addChecklistItemSchema }) body: AddChecklistItemInput): Promise<TaskDto> {
    return this.tasks.checklistAdd(u.id, id, body);
  }

  @Authz({ scope: 'board', needs: ['EDIT_TASKS'], author: 'or' })
  @Patch('tasks/:id/checklist/:itemId')
  editItem(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @Param('itemId', { schema: idSchema }) itemId: string,
    @Body({ schema: editChecklistItemSchema }) body: EditChecklistItemInput,
  ): Promise<TaskDto> {
    return this.tasks.checklistEdit(u.id, id, itemId, body);
  }

  @Authz({ scope: 'board', needs: ['EDIT_TASKS'], author: 'or' })
  @Delete('tasks/:id/checklist/:itemId')
  removeItem(@CurrentUser() u: AuthUser, @Id() id: string, @Param('itemId', { schema: idSchema }) itemId: string): Promise<TaskDto> {
    return this.tasks.checklistRemove(u.id, id, itemId);
  }

  // ---- comments

  @Authz({ scope: 'board', needs: ['CREATE_TASKS'] })
  @Post('tasks/:id/comments')
  comment(@CurrentUser() u: AuthUser, @Id() id: string, @Body({ schema: createCommentSchema }) body: CreateCommentInput): Promise<TaskCommentDto> {
    return this.comments.create(u.id, id, body);
  }

  @Authz({ scope: 'board', author: 'only' })
  @Patch('comments/:id')
  editComment(@CurrentUser() u: AuthUser, @Id() id: string, @Body({ schema: updateCommentSchema }) body: UpdateCommentInput): Promise<TaskCommentDto> {
    return this.comments.update(u.id, id, body);
  }

  @HttpCode(204)
  @Authz({ scope: 'board', needs: ['MANAGE_BOARDS'], author: 'or' })
  @Delete('comments/:id')
  async deleteComment(@CurrentUser() u: AuthUser, @Id() id: string): Promise<void> {
    await this.comments.remove(u.id, id);
  }

  // ---- files

  @RequireVerified()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Authz({ scope: 'board', needs: ['EDIT_TASKS'], author: 'or', verified: true })
  @Post('tasks/:id/attachments')
  @UseInterceptors(FileInterceptor('file'))
  async attach(
    @CurrentUser() u: AuthUser,
    @Id() id: string,
    @UploadedFile() file: UploadedTempFile | undefined,
    @Body({ schema: taskAttachmentFieldsSchema }) fields: TaskAttachmentFields,
  ): Promise<TaskAttachmentDto> {
    if (!file) throw new UnprocessableEntityException('file_required');
    return this.files.upload(u.id, id, file, fields);
  }

  @HttpCode(204)
  @Authz({ scope: 'board', needs: ['EDIT_TASKS'], author: 'or' })
  @Delete('tasks/:id/attachments/:attachmentId')
  async detach(@CurrentUser() u: AuthUser, @Id() id: string, @Param('attachmentId', { schema: idSchema }) attachmentId: string): Promise<void> {
    await this.files.remove(u.id, id, attachmentId);
  }
}
