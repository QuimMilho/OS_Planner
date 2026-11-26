# Phase 8: Direct messages

## Goal
A **Direct messages** tab (the rail's home entry) with private 1:1 conversations between members of a common team, reusing the chat engine from phase 7.

**Depends on:** 7. **Needed by:** 9.

## In scope / Out of scope
- In: 1:1 conversations, a DM list with unread state, start a DM from a member card, per-team "allow DMs" privacy, per-user block, close/reopen a conversation, attachments, reactions, replies, pins, edit/delete.
- Out: group DMs (not planned), threads in DMs (the reply feature covers it), voice/video calls in DMs, DMs with non-members.

## Data model
```
DirectConversation { id, userA CHAR(36), userB CHAR(36), createdAt, lastMessageAt }          unique (min(userA,userB), max(userA,userB)); stored with userA < userB
DirectState        { conversationId, userId, closedAt?, mutedUntil?, lastReadMessageId }     PK (conversationId, userId)
UserBlock          { blockerId, blockedId, createdAt }                                       PK
TeamSetting        { teamId, allowMemberDMs BOOL default true }                                (Team gets the column)
UserSetting        { userId, allowDMsFrom: members|nobody }                                   (User gets the column; default members)
```
- Messages reuse `Message` with `channelId` pointing at a **virtual channel** owned by the conversation: `Channel.kind = 'dm'` and `spaceId = <personal space of userA>`? **No**: DM bytes must not bill a team. Decision: a `dm` channel has `spaceId NULL`, `conversationId` set; attachments charge the **sender's personal space**; permission = "is one of the two participants and not blocked".
- Existing message endpoints work through a `ChannelAccess` abstraction (`TextChannelAccess` for team channels, `DmAccess` for DMs) introduced in this phase, so authorization stays in one place.

## API
- `GET /api/dms` (list with last message, unread, closed hidden), `POST /api/dms {userId}` (get-or-create), `POST /api/dms/:id/close|open`.
- Messages, attachments, reactions, pins use the phase 7 endpoints with the DM channel id; events go to room `channel:<id>` joined only by the two participants.
- Blocking: `PUT/DELETE /api/blocks/:userId`; `GET /api/blocks`.
- Eligibility check on create **and on every send**: both users are still members of at least one common team, neither blocked the other, the recipient allows DMs (`allowDMsFrom` and the shared team's `allowMemberDMs`; any one shared team that allows it is enough).
- When the last common team is gone, the history stays readable but sending returns `403 dm_not_allowed`.

## Web UI
- Rail home → **Direct messages**: list of conversations (avatar, presence dot from phase 6, last message, unread badge), search by name, "New message" picker listing people from your teams.
- Member list/profile card → "Message".
- DM view = the channel view from phase 7 without channel-only features (no slowmode, no thread creation).
- Per-conversation menu: mute (phase 9), close, block/unblock, "view shared teams".
- Settings → Privacy: who can DM me (members / nobody), blocked users list. Team settings → "Allow direct messages between members".
- Offline: same cache and queue as channels.

## i18n keys
`dm.*` (title, new, empty, notAllowed, blocked, closed), `settings.privacy.dms`, `settings.privacy.blocked`, `team.settings.allowDMs`.

## Security & permissions
- Participants only: any other user gets 404 on the conversation and its messages (not 403).
- A DM request never reveals whether the target exists or has blocked you: blocked/unavailable targets return the same `403 dm_not_allowed`.
- Staff of a team cannot read DMs (no moderator access); the audit log does not include DM content.
- Account deletion removes the user's side; messages from a deleted account are shown as "Deleted user".

## Quota impact
Attachments in DMs are charged to the *sender's* personal quota; text counts as documents bytes on the sender. Deleting a message refunds the sender.

## Implementation steps
1. `ChannelAccess` refactor behind the phase 7 controllers (no behaviour change; tests first).
2. Models + migration, DM service, eligibility rules, blocks, settings.
3. Endpoints and realtime room membership for DMs.
4. UI: DM list, new-DM picker, privacy settings.
5. Docs.

## Acceptance criteria
1. [server] Creating a DM twice returns the same conversation regardless of order of the pair.
2. [server] Non-participants get 404 on conversation, messages, attachments and reactions; moderators and admins included.
3. [server] Users with no shared team cannot start a DM (`dm_not_allowed`); after the last shared team ends, sending fails but history reads.
4. [server] `allowDMsFrom=nobody`, a block in either direction, and a team with `allowMemberDMs=false` (when it is the only shared team) each refuse with the same response shape.
5. [server] DM attachments charge the sender; over-quota is refused; deletion refunds.
6. [server] The shared `ChannelAccess` refactor leaves the phase 7 permission matrix unchanged (its test still passes unmodified).
7. [web e2e] A and B share a team: A messages B from the member list; B sees the unread badge, replies; both see live updates; B blocks A → A's next send fails with the neutral message.
8. [web e2e] C (no shared team) cannot find A in the picker and the direct URL of A's DM shows the 404 page.
9. [web e2e] Closing a conversation hides it from the list; a new message from the other side reopens it with an unread badge.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).

## Result

Done. Where the build differs from the plan above, and what later phases must know:

- **Data model.** `DirectConversation { id, userA, userB, channelId, createdAt, lastMessageAt }` with the pair stored ordered (`userA < userB`, unique);
  `userA`/`userB` are real foreign keys that become NULL when an account is deleted, so the other person keeps the history ("Deleted user") and the
  nightly chat job removes a conversation whose two sides are both gone. The conversation owns an ordinary `Channel` row of kind `dm` with
  `spaceId NULL` (`Channel.spaceId` became nullable; `conversationId` on the channel was replaced by `DirectConversation.channelId`, which is the
  same link read the other way). `DirectState` is just `{ conversationId, userId, closedAt }`: **read state reuses `ChannelRead`** and **mute reuses
  phase 9's `NotificationSetting`** (scope `dm`) instead of two more copies of the same columns. `UserBlock`, `Team.allowMemberDMs` and
  `User.allowDMsFrom` are as planned (`UpdateMe`/`UpdateTeam` carry them).
- **`ChatAccess`** (`apps/server/src/chat/channel-access.ts`) is the abstraction of the plan: `ChannelsService.textChannel()` returns one for a
  team channel (permissions from roles and overwrites) or for a conversation (`DirectAccess`: the two people only, fixed `DM_PERMISSIONS`, no
  moderation bits). `MessagesService`, `AttachmentsService` and the media access check all work through it, so the phase 7 permission matrix test passes
  **unmodified**. A DM has no threads (404 on thread endpoints and no thread bits); either person may pin; nobody can delete the other's message.
  `PermissionService.channelAccess` answers null for a channel without a space, so no team endpoint can ever reach a conversation.
- **Eligibility** (`DirectService.allowed`) is checked on create **and on every send, attachment upload, new reaction and new pin** (a retry of a message
  that is already stored is answered without checking again). Edit and delete of one's own messages are always possible. Every refusal is the same
  `403 dm_not_allowed`, for a missing person, oneself, a block either way, "nobody", a team that switched it off, or no shared team.
- **Billing.** `ChannelsService.billingSpace()`: a team channel bills its space, a conversation bills the **sender's personal space** (text through
  `Message.sizeBytes`, files as `Media` of that space), refunds go to the author. `QuotaService.breakdown('user')` counts their DM text as documents.
- **API beyond the plan**: `GET /api/dms?closed=`, `GET /api/dms/:id`, `POST /api/dms/:id/close|open` (200 with the conversation),
  `GET /api/dms/people?q=` (the picker: people of your teams that allow it; people you blocked are left out, people who blocked you or take nobody are
  **not**, which would reveal it), `GET/PUT/DELETE /api/blocks`. The conversation DTO carries the peer, last message, unread, `closed`, `blocked`
  (only your own block) and the teams you share. Events: `dm.updated` to `user:<id>` for **both** people on every message, on start, close and block
  (to the blocker only); the messages themselves use the channel room, whose authorizer accepts a conversation's two people (also when blocked: history reads).
- **Web.** Rail **Direct messages** (badge = unread over all conversations), sidebar list with presence and unread, `/app/dm` (picker) and
  `/app/dm/:id` (the chat screen in "dm" mode: header with the person, menu *close / block / shared teams*, no thread or slowmode UI). **Message** on
  every member in the team settings list. Settings → Privacy: who can message me and the blocked list; Team settings → Discover: allow direct messages. The
  conversation list is cached in IndexedDB (`dms`); messages use the channel cache and send queue unchanged. A message the server refused shows the neutral text.
- Tests: server +18 (`direct.test.ts`; plus the migration test), web e2e +3 (`dm.e2e.mjs`).
