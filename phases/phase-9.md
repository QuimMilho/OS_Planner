# Phase 9: Mentions, notifications and mute

## Goal
`@` mentions for members and roles (plus `@everyone`/`@here`), a notification system with in-app inbox, badges and Web Push, per-team/project/channel levels and mute durations, and an **email** option that is configured separately per chat.

**Depends on:** 7, 8 (and 6 for delivery). **Needed by:** 12 and 13 (task mentions and reminders reuse the pipeline).

## In scope / Out of scope
- In: mention parsing and autocomplete, notification generation, delivery channels (in-app, Web Push, email), settings with inheritance, mute with durations, inbox, badges, quiet hours.
- Out: SMS, mobile-native push (APNs/FCM beyond Web Push), digest scheduling beyond the "while away" batching below.

## Mentions
- Composer: typing `@` opens an autocomplete of members (nickname/name) and roles (only `mentionable` roles, or all if the author has `MENTION_EVERYONE`) plus `@everyone` and `@here` (only with `MENTION_EVERYONE`). Stored in the message as tokens: `<@user:UUID>`, `<@role:UUID>`, `<@everyone>`, `<@here>` and resolved to names on render (names follow renames).
- `Message.mentions JSON` is computed **server-side** from the content; clients cannot forge it. Mentions of someone who cannot view the channel produce no notification (and the UI warns the author).
- `@here` = members currently online (presence from phase 6) who can view the channel. `@everyone` = all who can view it. `@role` = members of the role who can view it.
- Mentions also work in task comments and descriptions (phase 12) and meeting descriptions (phase 13) through the same service.

## Data model
```
NotificationSetting { id, userId, scopeKind: global|team|project|channel|dm, scopeId?, level: all|mentions|none|inherit,
                      suppressEveryone BOOL?, suppressRoles BOOL?, suppressDirect BOOL?, mutedUntil DATETIME? (NULL=not muted; far-future sentinel = until turned on),
                      email: off|mentions|all|inherit, emailOnlyWhenAway BOOL default true, push BOOL? }          unique (userId, scopeKind, scopeId)
Notification        { id, userId, kind: mention_user|mention_role|mention_everyone|mention_here|dm|reply|thread|invite|task_assigned|task_due|task_comment|meeting_invite|meeting_reminder|join_request|…,
                      actorId?, spaceId?, channelId?, messageId?, targetKind?, targetId?, summary, readAt?, createdAt }   index (userId, readAt, createdAt)
PushSubscription    { id, userId, endpoint UNIQUE, p256dh, auth, userAgent, createdAt, lastSeenAt }
EmailDigestState    { userId, scopeKind, scopeId, lastEmailedAt, pendingCount }
```
- Resolution of the effective setting for a message: **channel → project chain (nearest first) → team → global**, `inherit` falls through; the global default is `mentions` (DMs: `all`). `mutedUntil` at any level mutes that level and everything below it unless a lower level sets its own `mutedUntil` in the past or `level=all` *with* an explicit un-mute.
- Mute durations: 15 minutes, 1 hour, 3 hours, 8 hours, 24 hours, until turned back on (UI presets; API takes any future timestamp).
- **Different mute options per mention type**: `suppressEveryone` (`@everyone` and `@here`), `suppressRoles` (`@role`), `suppressDirect` (direct `@you`; off by default and not offered at the global level, so a direct mention is the last thing to be silenced). A fully muted scope still allows direct mentions only if `suppressDirect=false`.

## Delivery pipeline
1. A domain event (`message.created`, `task.assigned`, …) → `NotificationService.plan(event)` computes recipients (visibility + effective settings + not the author + not blocked) and writes `Notification` rows in the same transaction as the source write.
2. After commit: **in-app** → socket event `notification.created` to `user:<id>`, badge counters updated; **push** → Web Push (VAPID) if the user has subscriptions, the setting allows it and no live socket is currently focused on that channel; **email** → queued when the *chat's* email option says so.
3. **Email** is its own option per chat, not a side effect of notifications: `off | mentions | all`, "only when I'm not active" default on (no socket activity for 10 min). Emails are batched per channel (at most one per 15 minutes, with a count and the last N messages), localised (en/pt), contain a one-click "mute this channel" and "unsubscribe" link with a signed token, and never include attachments.
4. Unread counters: `unread` (messages after `lastRead`) and `mentionCount` per channel/DM/team, delivered through `GET …/unread` and live events.

## API
- `GET/PUT /api/notification-settings` (list + upsert by scope), `DELETE /api/notification-settings/:id`, `POST /api/notification-settings/mute {scopeKind, scopeId, until}`.
- `GET /api/notifications?cursor=&unread=`, `POST /api/notifications/read {ids|all, before?}`, `GET /api/notifications/count`.
- Push: `GET /api/push/vapid-key`, `POST /api/push/subscribe`, `DELETE /api/push/subscribe`. Mail links: `POST /api/mail/unsubscribe {token}` and `GET` landing page route.
- Env: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; documented generator command. Push is disabled (and hidden in the UI) without keys.

## Web UI
- Composer autocomplete (members, roles, everyone, here) with role colours and presence.
- Rendering: mention chips (highlight when it is you or your role); clicking a member opens their card.
- **Bell** with the inbox (grouped by day, mark all read, filter *mentions / all*), badge counts on rail icons, channel and DM entries.
- Context menu on team/project/channel/DM → **Notification settings**: level radio (all / only mentions / nothing / use parent), suppress toggles (everyone/here, roles, direct), mute presets, **Email** section (off / mentions / every message + "only when I'm away"), push toggle, shows the *effective* result and where it comes from.
- Settings → Notifications: global defaults, quiet hours (local time, days), Web Push enable (permission prompt after a click), per-device list.
- Service worker handles `push` and `notificationclick` (focus or open the deep link); Electron maps notifications to native ones through the same payload.

## i18n keys
`mentions.*`, `notif.*` (levels, mute presets, suppress toggles, email options), `inbox.*`, `push.*`, `mail.notification.*`, `mail.unsubscribe.*`.

## Security & permissions
- Recipients are computed server-side from visibility; a mention never reveals content to someone who cannot view the channel (the payload shows a generic title for push/email on channels with `redactPreviews`).
- `MENTION_EVERYONE` required for `@everyone`/`@here`/non-mentionable roles; otherwise the tokens are stored as plain text.
- Push payloads contain no secrets and are encrypted per Web Push; subscription endpoints validated (https, known push services) and removed on 404/410.
- Unsubscribe tokens are signed, scoped to one user and scope, expiring after 60 days, and idempotent.
- Rate limits: mention fan-out capped per message (`@everyone` in a team over 5000 members is refused) and notifications coalesced per user/channel (one push per 10 s per channel).

## Quota impact
Notifications are tiny and pruned after 90 days (nightly job); not charged.

## Implementation steps
1. Mention tokenizer + resolver in `@notes/shared`; composer UI.
2. Models, settings resolution (pure function in shared, unit-tested).
3. `NotificationService` + pipeline integration with message creation.
4. In-app inbox and counters; realtime events.
5. Web Push (service worker, subscription, sender with `web-push`).
6. Email batching, templates, unsubscribe.
7. Settings UI, per-scope dialog; Electron notification mapping; docs.

## Acceptance criteria
1. [unit] Setting resolution: matrix over (channel, project chain, team, global) × (level, mute, suppress flags) returns the documented effective result; direct mentions are the last to be silenced; `inherit` falls through; expired mutes ignored.
2. [unit] Mention parser: tokens extracted from content, unknown/forged ids dropped, escape rules, no mention inside code blocks.
3. [server] `@user`, `@role`, `@everyone`, `@here` create notifications for exactly the right people (visible, online for `@here`, not the author); users without view access get none.
4. [server] `suppressEveryone` silences `@everyone`/`@here` but not `@you`; `suppressRoles` silences role mentions only; a mute with a future timestamp silences, a past one does not.
5. [server] A non-`MENTION_EVERYONE` author's `@everyone` is stored as text and notifies no one.
6. [server] Email: `mentions` mails only mentioned users, `all` mails everyone with the option on, `off` mails no one; batching sends one mail per 15 min per channel; "only when away" skips users with an active socket; the unsubscribe link switches the option off for that scope only.
7. [server] Push: subscription saved and removed on 410; payload for a redacted channel contains no message text.
8. [server] Counters: unread and mention counts stay correct after edits, deletes and reads (property test against a reference).
9. [web e2e] A mentions B (member) and role R; B's bell increments live, the channel is highlighted, opening it clears the badge; a user in R receives it, a user outside does not.
10. [web e2e] B mutes the channel for 1 h; a non-direct message does not badge the bell; a direct mention still does until "suppress direct" is on; unmute restores.
11. [web e2e] Email option "mentions" on a channel: Mailpit receives exactly one mail after B goes idle, in B's language; the unsubscribe link works without login.
12. [web e2e] Web Push: with test VAPID keys, subscribing registers an endpoint; a message triggers a push call (intercepted by a fake push service) and clicking opens the deep link. [manual] OS-level notification appearance on Windows and Linux (Electron).

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).
