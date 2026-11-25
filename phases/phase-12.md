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
- The description subset is validated server-side (reduced schema from `@notes/shared`); no embedded media types beyond images/links.
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
