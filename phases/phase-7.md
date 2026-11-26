# Phase 7: Chat channels

## Goal
Discord-like text channels in teams, projects and sub-projects: messages, edit/delete, attachments with image previews, reactions, replies, pins and threads, with history paging, an offline read cache and a send queue.

**Depends on:** 4 (permissions), 6 (realtime). **Needed by:** 8, 9, 16.

## In scope / Out of scope
- In: text channels and channel categories, messages (Markdown), edit/delete, attachments, reactions, replies, pins, threads, search within a channel, unread markers, moderation.
- Out: DMs (8), mentions and notification levels (9), voice (16), group DMs, typing indicators and read receipts (not planned). A private `lastRead` marker exists for unread counts only.

## Data model
```
Channel      { id, spaceId, parentId? (category), kind: text|category|voice, name, topic, position, nsfw?=false, slowmodeSeconds, archivedAt?, createdBy, createdAt, deletedAt }
Message      { id (UUIDv7), channelId, threadId?, authorId, content TEXT (Markdown, ≤ 4000 chars), replyToId?, editedAt?, deletedAt?, pinnedAt?, pinnedBy?, createdAt, seq BIGINT }  index (channelId, id)
Attachment   { id, messageId, mediaId, name, mime, size, width?, height? }          media rows reuse Media + storage driver
Reaction     { messageId, userId, emoji VARCHAR(32) }                                PK (messageId, userId, emoji)
Thread       { id, channelId, rootMessageId UNIQUE, name, archivedAt?, createdBy, lastMessageAt }
ChannelRead  { userId, channelId, lastReadMessageId, updatedAt }                     PK
```
- Channels are ordinary permission targets: `Overwrite(targetKind=channel)` from phase 4.
- Message ids are client-generated UUIDv7 (idempotent sends and ordering by id); `seq` per channel for catch-up.
- Soft delete keeps a tombstone (`deletedAt`, content cleared) so replies still render "message deleted".
- Markdown stored as text; rendered through a safe renderer (no raw HTML). Link previews are out of scope.

## API
- Channels: `GET/POST /api/spaces/:id/channels`, `PATCH/DELETE /api/channels/:id`, `PUT /api/spaces/:id/channels/order` (`MANAGE_CHANNELS`).
- Messages: `GET /api/channels/:id/messages?before=&after=&limit=50` (cursor by id), `POST /api/channels/:id/messages {id, content, replyToId?, attachmentIds?}` (idempotent by id), `PATCH /api/messages/:id` (author, content only), `DELETE /api/messages/:id` (author or `MANAGE_MESSAGES`).
- Attachments: `POST /api/channels/:id/attachments` (multipart; counted against the owning space quota; images get dimensions and EXIF stripped as today; allowlist as for media).
- Reactions: `PUT/DELETE /api/messages/:id/reactions/:emoji`. Pins: `PUT/DELETE /api/messages/:id/pin` (`MANAGE_MESSAGES`), `GET /api/channels/:id/pins`.
- Threads: `POST /api/messages/:id/thread {name}` (`CREATE_THREADS`), `GET /api/threads/:id/messages`, send with `threadId`; archive/unarchive by creator or `MANAGE_MESSAGES`.
- Search: `GET /api/channels/:id/search?q=` (MySQL FULLTEXT on `content`, same accent-insensitive collation).
- Read state: `PUT /api/channels/:id/read {messageId}`; `GET /api/spaces/:id/unread` (counts per channel).
- Events (room `channel:<id>`): `message.created|updated|deleted`, `reaction.added|removed`, `message.pinned|unpinned`, `thread.created|updated`, `channel.updated`.

## Web UI
- Team/project sidebar: channel categories and channels (drag to reorder), unread bold + count badge, project-scoped channels grouped under their project.
- Channel view: virtual-scrolled message list (grouped by author/day), composer (Markdown toolbar, emoji picker, attach by button/drag/paste, reply preview, Esc cancels, ↑ edits last), reactions bar, hover actions (reply, react, thread, pin, edit, delete, copy link), pinned drawer, thread side panel, channel search, "jump to unread".
- Image attachments render inline with lightbox; other files as download chips.
- Offline: last 200 messages per opened channel cached in Dexie (`messages`, read-only); the composer queues sends in the outbox with a "sending…" state and retries in order; failed sends can be retried or removed.
- Markdown rendering shared with exports (`@os-planner/shared`), code blocks highlighted, `Ctrl+Enter` setting.

## i18n keys
`chat.*` (composer, actions, empty states, unread), `channel.*` (create, category, topic, slowmode, archive), `thread.*`, `reaction.*`, `pins.*`, `attachment.*`, `errors.messageTooLong`, `errors.slowmode`.

## Security & permissions
- Bits: `VIEW_CHANNEL`, `READ_MESSAGE_HISTORY`, `SEND_MESSAGES`, `ATTACH_FILES`, `ADD_REACTIONS`, `CREATE_THREADS`, `SEND_IN_THREADS`, `MANAGE_MESSAGES`, `MANAGE_CHANNELS`.
- No `VIEW_CHANNEL` → 404 everywhere (messages, attachments, reactions, threads, search); no `READ_MESSAGE_HISTORY` → only messages created after joining the room are visible.
- Attachment URLs use the media-token mechanism and check channel visibility at fetch time; leaving the team ends access.
- Markdown sanitised on render; messages never contain executable HTML; URLs checked with `isSafeHref`.
- Edits limited to the author; moderators can delete, not edit. Slowmode and per-user rate limit enforced server-side.
- Deleting a channel/message deletes attachment bytes through the media GC and refunds quota.

## Quota impact
Attachments charge the *space* that owns the channel (team or project; project also counts toward its team). Message text is small and counted as `documents` bytes (length of content) so heavy chatting cannot be unbounded: 413 `quota_exceeded` with scope. Rejected attachments leave no orphan files.

## Implementation steps
1. Models + migrations (+ FULLTEXT on `Message.content`).
2. `ChannelsModule`, `MessagesModule`, attachment upload via the existing media pipeline with a `channelId` owner.
3. Events + realtime bridge; catch-up endpoint (`after`).
4. Reactions, pins, threads, read state, search.
5. UI: sidebar, message list (virtualised), composer, side panels.
6. Offline cache and send queue; i18n; docs.

## Acceptance criteria
1. [server] Permission matrix for each bit (allowed / denied / not a member = 404) over every endpoint, generated from one table.
2. [server] Sending is idempotent: posting the same id twice stores one message; ids order messages; `before/after` paging returns each message exactly once across pages.
3. [server] Edit by non-author 403; delete by author or moderator ok; deleted message shows a tombstone to repliers; content is cleared in the DB.
4. [server] Attachment limits: type allowlist by magic bytes, size limits, quota charged to the space and refunded on delete; an over-quota upload stores nothing.
5. [server] Threads: one thread per root message; messages with `threadId` do not appear in the channel list; archived thread refuses sends.
6. [server] Reactions: unique per (message, user, emoji), counts correct under concurrency, removed on message deletion.
7. [server] Search finds `acentuacao` for `acentuação`, scoped to channels the caller can view.
8. [server] Without `READ_MESSAGE_HISTORY` old messages are not returned.
9. [web e2e] Two users in one channel: A sends, B sees it live; edit, react, reply, pin and thread all propagate live; unread badge on B's other channel clears when opened.
10. [web e2e] Offline: B opens a channel, goes offline, still reads cached history, queues two messages, comes online → delivered once, in order.
11. [web e2e] Denying `VIEW_CHANNEL` for B on a channel removes it from B's sidebar immediately and the URL shows the 404 page.
12. [web e2e] Pasting an image sends an attachment shown inline; clicking opens the lightbox; the file counts in the team's usage.
13. [unit] Markdown renderer: raw HTML and `javascript:` links are neutralised (fixture set shared with the notes Markdown tests).

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).
