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
