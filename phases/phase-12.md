# Phase 12: Boards and tasks

## Goal
Task boards with labels and projects. Boards live in a team, a project/sub-project, or privately in the personal space. Tasks carry dates (which feed the calendar in phase 13), assignees, labels, checklists, subtasks, comments and attachments.

**Depends on:** 4, 6 (live updates); 9 for mentions. **Needed by:** 13, 15.

## In scope / Out of scope
- In: boards, columns (custom, WIP limits), tasks, subtasks, checklists, assignees, priority, start/due dates, labels (team-scoped, inheritable by projects), comments with mentions, attachments, activity feed, board/list/"My tasks" views, filters, drag and drop, personal boards, archive and trash.
- Out: Gantt/dependencies, time tracking, automations, custom fields (listed as later work).

## Data model
```
Board       { id, spaceId, name, description, icon, color, position, archivedAt?, seq, createdBy, createdAt, deletedAt }
Column      { id, boardId, name, position, wipLimit INT?, kind: todo|doing|done|custom, color?, seq, deletedAt }     // `done` columns mark tasks complete
Task        { id, boardId, columnId, spaceId, parentTaskId?, title, description JSON (TipTap, small subset), position,
              priority: none|low|medium|high|urgent, startAt?, dueAt?, allDay BOOL, completedAt?, createdBy, createdAt, updatedAt, seq, deletedAt }
TaskAssignee{ taskId, userId, assignedBy, assignedAt }                                             PK (taskId, userId)
Label       { id, spaceId, name, color, description?, inheritable BOOL default true, seq, deletedAt }              // a project sees labels of its ancestors + team
TaskLabel   { taskId, labelId }                                                                    PK
ChecklistItem { id, taskId, text, done, position, seq }
TaskComment { id, taskId, authorId, content (Markdown, mentions), editedAt?, createdAt, deletedAt }
TaskAttachment { id, taskId, mediaId, name, size, mime }
TaskActivity { id, taskId, actorId, kind, data JSON, createdAt }                                   // append-only
```
- Every row carries `seq` of its **space** for sync (phase 3 mechanism), tombstones via `deletedAt`.
- Field versions for merge (phase 15) are added there (`fieldSeq JSON`).
- Positions use the existing fractional-index strings; never `ORDER BY position` in SQL.
- A task's `spaceId` equals its board's; moving a task between boards of different spaces re-attributes it (requires create rights on the target).

## API
- Boards: `GET/POST /api/spaces/:id/boards`, `GET/PATCH/DELETE /api/boards/:id` (GET returns columns, tasks, labels, members who can be assigned), `POST /api/boards/:id/duplicate`.
- Columns: `POST /api/boards/:id/columns`, `PATCH/DELETE /api/columns/:id` (delete moves tasks to a chosen column), reorder.
- Tasks: `POST /api/boards/:id/tasks`, `GET/PATCH/DELETE /api/tasks/:id`, `POST /api/tasks/:id/move {columnId, position, boardId?}`, subtasks via `parentTaskId`, `PUT/DELETE /api/tasks/:id/assignees/:userId`, `PUT/DELETE /api/tasks/:id/labels/:labelId`, checklist CRUD, comments CRUD, attachments (media pipeline, quota of the space).
- Labels: `GET/POST /api/spaces/:id/labels`, `PATCH/DELETE /api/labels/:id` (`MANAGE_LABELS`).
- Views: `GET /api/me/tasks?assigned=me&status=&due=&spaceId=` (across spaces the user can view), `GET /api/spaces/:id/tasks?…`.
- Sync: boards, columns, tasks (without comments/activity, fetched on open), labels, assignments are included in `GET /api/sync/changes` per space.
- Events: `board.updated`, `task.created|updated|moved|deleted`, `comment.created`, `label.*` on room `space:<id>` and `board:<id>`.

## Permissions (bits 23–28)
`VIEW_BOARDS`, `CREATE_TASKS`, `EDIT_TASKS` (edit any task; authors/assignees may edit their own title/description/checklist/done without it), `ASSIGN_TASKS`, `MANAGE_BOARDS` (boards/columns/WIP), `MANAGE_LABELS`. Overwrites can target a board. Personal boards: owner only.

## Web UI
- Sidebar section **Boards** per space; board view (Kanban) with drag and drop between columns and reorder, WIP indicators, quick add, collapsed columns, swimlanes by assignee (option), filters (assignee, label, due, priority, text), saved filters per user.
- Task drawer: title, description (reduced TipTap), assignees (people picker, "assign to me"), labels, priority, start/due (date or date-time, all-day), checklist with progress, subtasks, comments with `@` mentions (phase 9), attachments, activity timeline, copy link, duplicate, archive.
- **List view** (table with sort, group, inline edit) and **My tasks** (cross-team, grouped by due: overdue, today, upcoming, no date).
- Labels manager; colours respect themes (text colour chosen for contrast).
- Offline: boards and tasks of opened spaces are cached and editable offline (phase 15 defines merge); read-only roles see a locked UI.
- Keyboard: `C` new task, `Enter` open, arrows to move focus, `Alt+←/→` move task between columns.

## i18n keys
`board.*`, `column.*`, `task.*` (fields, priority levels, due states), `label.*`, `checklist.*`, `myTasks.*`, `activity.*` (one key per `TaskActivity.kind`).

## Security & permissions
- Visibility inherited: no `VIEW_BOARDS` → 404 on boards, tasks, comments, attachments, labels in that space/board.
- Assignees must be able to view the board; assigning someone who cannot is rejected with a clear error.
- Comment edit by author only; delete by author or `EDIT_TASKS`/`MANAGE_BOARDS`.
- The description subset is validated server-side (reduced schema from `@os-planner/shared`); no embedded media types beyond images/links.
- `/api/me/tasks` returns only tasks in spaces the caller can view at request time.

## Quota impact
Attachments charge the owning space (and team for projects). Task text counts as documents bytes (`description` JSON size + comments). Archive does not refund; hard delete does.

## Implementation steps
1. Models + migration; extend sync and tombstones; `BoardsModule`/`TasksModule`/`LabelsModule`.
2. Permission integration and overwrites on boards.
3. Events and notifications hooks (assigned, due, comment, mention).
4. Board UI with drag and drop, task drawer, list and My tasks views.
5. Offline cache (Dexie `boards`, `columns`, `tasks`, `labels`, `outbox` ops) and basic push of changes (merge rules in phase 15).
6. Docs.

## Acceptance criteria
1. [server] Permission matrix per bit across all endpoints (allowed / denied / non-member 404); personal boards are invisible to others.
2. [server] Moving a task updates `columnId`/`position`, enforces WIP limits (409 with `wip_limit`), writes an activity entry and a space `seq`; concurrent moves keep a consistent order.
3. [server] Assigning a user who cannot view the board fails; unassigning works; `GET /api/me/tasks` returns exactly the caller's tasks in viewable spaces, sorted by due date.
4. [server] Labels: inheritable labels of a team show in its projects, not vice versa; deleting a label removes it from tasks (tombstones synced).
5. [server] Attachment and comment size limits; over-quota attachment refused with scope; hard delete refunds.
6. [server] Sync: creating, updating, moving and deleting tasks appear in `changes` with tombstones; `revokedSpaces` hides boards after removal from the team.
7. [unit] Fractional position helper keeps order after many inserts between two tasks.
8. [web e2e] Create a board with three columns and tasks; drag between columns; the second user sees it live; WIP limit blocks a drop with a message.
9. [web e2e] Task drawer: assign, label, set dates, add checklist and subtask, comment with `@` mention (notification arrives for the mentioned user); activity shows each step.
10. [web e2e] My tasks lists tasks from two teams plus a personal board and groups overdue/today/upcoming correctly (fixed clock via `page.clock`).
11. [web e2e] Offline: edit a task title and move it while offline; after reconnecting, the server has the changes (basic push; conflict cases covered in phase 15).
12. [web e2e] A member with view-only role sees the board but cannot edit, drag or add tasks.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).

## Result

Done. Where the build differs from the plan above, and what later phases must know:

- **Server: `apps/server/src/boards/`.** `BoardsService` (boards, columns, duplicate, trash/restore), `TasksService` (create, update, move, delete, restore, purge, detail, activity, one-at-a-time
  assignee/label/checklist calls), `TaskCommentsService`, `TaskAttachmentsService`, `LabelsService`, `TaskViewsService` (`/api/me/tasks`, `/api/spaces/:id/tasks`, `/api/board-permissions`),
  `TaskAccess` (a task + what the caller may do with it), `BoardEvents`, `BoardsMaintenance` (hourly due-soon notices, nightly purge of what has been in the trash 30 days). Models:
  `Board`, `BoardColumn` (not `Column`: a reserved word), `Task`, `TaskAssignee`, `Label`, `TaskLabel`, `ChecklistItem`, `TaskComment`, `TaskAttachment`, `TaskActivity`, `TaskMove`.
- **Checklist items, assignees and labels ride inside the task row** (`TaskDto.checklist/assigneeIds/labelIds`) and every change to them bumps the task's `seq`; there are no separate sync
  tombstones for them (the plan gave `ChecklistItem` its own `seq`). `commentCount`/`attachmentCount` are counters on the task. Comments, activity and attachments are not synced: they are fetched
  when a task is opened (`GET /api/tasks/:id`). `TaskComment` has no tombstone: deleting a comment removes the row and refunds its bytes.
- **Permissions.** Bits 23–28 were already defined. `PermissionService` gained `boardAccess/requireBoard` (VIEW_BOARDS + the board's overwrites; a personal board is its owner's alone),
  `requireBoardSpace`, `hiddenBoards`, `boardViewers` (who can see a board, in one batch, for assignees/mentions/notifications), `boardPermissions` and `boardSpaces`. Overwrites accept `targetKind:
  'board'` (MANAGE_BOARDS; not on personal boards). Rules for a task: *create* CREATE_TASKS (+ASSIGN_TASKS to name assignees); *change* EDIT_TASKS, or, for whoever made it or is assigned,
  only `title`, `description`, `checklist`, `completed`; *assignees* ASSIGN_TASKS; *move* EDIT_TASKS or the same "own" rule; *delete* EDIT_TASKS or the creator; *comment* CREATE_TASKS (a
  decision: the plan did not say), edit = author only, delete = author or EDIT_TASKS/MANAGE_BOARDS; *files* whoever may edit the task. An archived board is read-only (`422 board_archived`).
- **Concurrency: board writes run in READ COMMITTED** (`PrismaService.fresh()`). Under the default REPEATABLE READ a transaction kept reading the snapshot of its first read, so after waiting for the
  space lock (`ChangeSeqService.next`) it still saw the state from before the writer ahead of it committed: two racing moves into a column with room for one both got in. (This applies to any
  future "check, then write, under the space lock" code: use `fresh()`.) Positions: two tasks with the same key (two people dropping at the same place) are told apart by moving the later one just after;
  a key longer than `POSITION_REBALANCE_LENGTH` (40) re-keys the whole column in the same order (`evenPositions`). Both are in `shared/dto/position.ts` with tests (500 inserts at one spot reach 86
  characters without it; the column holds 64).
- **WIP limit:** `409 wip_limit` for a move into (or a create in) a full column; subtasks do not count; moving inside the column is not an arrival. Finishing a task (`completed: true`) moves it to the first
  `done` column, but never fails because that column is full (it stays, ticked); reopening needs room in the column it goes back to. A column that changes `kind` to/from `done` completes/reopens its tasks.
- **Sync.** `SpaceChangesDto` gained `boards, columns, tasks, labels` (always present for a space whose boards the person can see, even when empty), `hiddenBoards` and `movedOutTasks`; a space is
  asked for when the person may see its notebooks *or* its boards. New ops `task.create|update|move|delete|restore` in `POST /api/sync/batch` (boards, columns, labels, comments and files are online-only),
  new error code `wip_limit`. A task moved to a board of another space re-attributes its bytes (and files) in one transaction and leaves a `TaskMove` row so the space it left tells its devices
  (`movedOutTasks`); its assignees who cannot see the target board and labels that are not usable there are dropped.
- **Realtime.** `JOINABLE_ROOM_KINDS` gained `board`. The row goes to `board:<id>` (only people who may see the board can be in it; rechecked on every permission change); the room of the space gets the same
  event name with just `{spaceId, boardId, id}`, so a board hidden from somebody stays hidden. Events: `board.updated {board, columns}`, `task.created|updated|moved|deleted`, `comment.created`,
  `label.created|updated|deleted`.
- **Notifications.** `NotificationService.onTask` (inbox row in the transaction, live event, Web Push; skipped when the person muted the team/project): `task_assigned`, `task_comment` (assignees and creator,
  minus the author and the mentioned), `mention_user` with `targetKind: 'task'` for an `@` in a comment (only people who can see the board count; roles/`@everyone`/`@here` are plain text), and `task_due`
  (hourly, once per due date: `Task.dueNotifiedAt`, reset when the due date changes). The inbox opens `/app/task/:id`, which resolves the board. The inbox hides a task notification once its board is not visible.
- **Quota.** Task text (`title` + description JSON) and comments are charged to the space as documents (and show in the storage breakdown); files go through `MediaService.store` (so: sniffed by content, EXIF
  stripped, pictures and videos only). Soft delete never refunds; `DELETE /api/tasks/:id/purge` (a trashed task only) and the nightly purge do, files included. `MediaService.accessible` serves a task file to whoever
  can see its board; the orphan-media job leaves task files alone.
- **Shared** gets a fourth entry `@os-planner/shared/boards` (schemas, limits, `validateTaskDescription`, `dueState/groupByDue/compareByDue`, label colours and `textColorOn`); the main entry exports only the types.
  The description is a hand-written validator (paragraph, lists, `hardBreak`, text with bold/italic/strike/code/link; links http(s)/mailto only; depth, node and size caps), run on the server and before saving in the web app.
- **Web.** Dexie v7 (`boards`, `columns`, `tasks`, `labels`); `data/board-store.ts` (reads, offline task changes through the outbox, online board/column/label changes, the room of an open board);
  `features/boards/`: `board-list` (sidebar), `board-page` (Kanban with CDK drag and drop, list view, filters + saved filters, swimlanes, keyboard), `task-drawer` (a dialog on the right, opened by `?task=`),
  `board-dialogs` (settings/columns, labels, deleted tasks), `my-tasks-page`. "My tasks" is computed from the local copy. A move refused by the server (full column) is dropped from the outbox and the task is
  re-read so the screen shows where it really is. Saved filters are kept on the device (Dexie `meta`), not per account on the server.
- **Not done / left for later phases:** per-field merge of conflicting task edits (phase 15: today the later request simply wins field by field, and a refused op is reported); due dates are not on a
  calendar yet (phase 13); the description has no images (attach them as files); comments are not editable offline; `fieldSeq` is not added.
- **Proxy.** No change to `deploy/nginx/os-planner.conf.template`: everything is under `/api/`, the board room uses the existing realtime WebSocket, and uploads are covered by `client_max_body_size`.
- **Tests.** shared +26, server +28 (`boards.test.ts`; plus the phase 12 case in `migration.test.ts`), web e2e +5 (`boards.e2e.mjs`).
