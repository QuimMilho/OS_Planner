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
1. Mention tokenizer + resolver in `@os-planner/shared`; composer UI.
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

## Result

Done. Where the build differs from the plan above, and what later phases must know:

- **Shared, pure.** `@os-planner/shared/chat`: `mentions.ts` (tokens `<@user:UUID>`, `<@role:UUID>`, `<@everyone>`, `<@here>`; the parser has a `mention` node and a
  backslash escapes it; `extractMentions` reads the *parsed tree*, so code and escapes cannot disagree with what is drawn), `notify.ts`
  (`resolveSetting`, `shouldNotify`, `shouldEmail`, `strongest`, `inQuietHours`), and `dto/notifications.ts`. **Resolution rules as built:** every setting is looked up on its
  own along *channel → projects (nearest first) → team → global* (a conversation: itself → global); the nearest scope that says something wins and `inherit`/nothing falls through.
  A mute is the nearest scope that set `mutedUntil` at all: still running = muted, **already ended = an explicit un-mute** (which is what "unmute inside a muted team" stores).
  "Nothing" and a mute silence everything except a direct mention; `suppressEveryone` (@everyone and @here), `suppressRoles` and `suppressDirect` each switch off their own kind
  whether or not the scope is muted; `suppressDirect` is refused at the global level; replies count as direct mentions. Defaults: channels `mentions`, conversations `all`.
- **Mentions are decided by the server** (`MentionsService.accept`): a person counts if they are a team member who can see the channel (bulk check
  `PermissionService.channelViewers`, tested to agree with `channelAccess` for everyone), a role if it is a role that applies here and is mentionable (or the author has
  `MENTION_EVERYONE`), `@everyone`/`@here` only with that permission; the result is stored in `Message.mentions` and sent in the DTO, the text is never rewritten and a token
  that was not accepted is drawn as plain text. `@everyone` in a team over 5000 members is `422 everyone_too_large`. Conversations have no mentions.
- **Pipeline.** `NotificationService.onMessage(tx, …)` runs inside the message's transaction: recipients are the mentioned (user, role, everyone, here = online by presence) and the replied-to
  author, plus people who asked for *every* message or email (found through their setting rows), all filtered by visibility and by blocks, resolved per person; inbox rows
  are written in the same transaction (an ordinary message for somebody on "everything" gets a push or mail but **no inbox row**). An edit adds notifications only for newly mentioned
  people and removes those of people no longer mentioned; a delete removes them all; a message already read becomes a read notification. After the commit: live event
  `notification.created`, then push; email waits for the sweep.
- **Counters.** `UnreadDto.mentions` (unread mention/reply notifications per channel) next to `unread`; `GET /api/notifications/count` gives unread, mentions, per team and unread DMs.
  `PUT /channels/:id/read` marks that channel's notifications read; `notification.read` keeps other devices in step. A randomised test checks both counters against a reference model.
- **Push.** `web-push` builds the encrypted request, the server sends it itself with `fetch` (no redirects, 10 s timeout) after checking the address: https and a known push
  service (Google, Mozilla, Apple, Microsoft) or an origin in `PUSH_EXTRA_ENDPOINTS` (also how tests use a local fake). 404/410 removes the device; at most 10 devices per person; no VAPID keys =
  `404` on the push endpoints and the UI hides it. Sent unless: the person turned push off for the place, quiet hours, a page of theirs is showing that channel and was used in the last
  minute (the page reports `focus` with `presence:activity`), or one went out for that channel within `NOTIFY_PUSH_COALESCE_SECONDS`. The payload is Angular's service-worker format
  (`notification.data.onActionClick` opens the deep link), so no custom service worker was needed. **Channels have a new `redactPreviews` option** (age-restricted channels count too): push, email and the inbox then carry
  no message text at all (it is not even stored in the notification).
- **Email.** Per chat (`channel` or `dm` scope) from the settings; each message adds to `EmailDigestState`; a sweep (`NOTIFY_SWEEP_SECONDS`) sends at most one mail per chat every
  `NOTIFY_EMAIL_INTERVAL_MINUTES`, re-reads the person's *current* settings (so unsubscribing drops what was waiting), skips people with a page used in the last `NOTIFY_AWAY_SECONDS` when they asked for "only
  when away", quiet hours, and messages already read or deleted. Mails are localised, list the last 5 messages, carry `List-Unsubscribe` and two signed 60-day links to
  `/mail/action` (mute this chat, stop the mails) that need no login, change only that chat and are idempotent.
- **Deviations.** `NotificationSetting.scopeId` is `''` for the global scope (a unique key over NULL would allow duplicates). `EmailDigestState` also keeps the pending message ids.
  `PUT /api/notification-settings` and the mute endpoint answer 204 when a row ends up saying nothing. Roles for the `@` list come from `GET /api/teams/:id/roles`.
  Every scope has its settings button: the team (sidebar), a project (its page), a channel and a conversation (their headers) and the global defaults (Settings). **Web bundle:** the two translation files are imported statically, so the new
  texts pushed the initial bundle 4 kB over its 2.1 MB budget: the error budget is now 2.2 MB (loading the second language lazily is the real fix, see phase 17).
- **Web.** `@` autocomplete in the composer (people with presence, roles with colour, @everyone/@here with the permission), chips in messages (stronger when it is you), a highlighted message when it
  mentions you, the **bell** with the inbox (all / mentions, grouped by day, mark all read), mention badges on channels and on the team in the rail, the **Notification settings** dialog (team, channel, conversation, global) with the
  effective result, Settings → Notifications (defaults, quiet hours, Web Push for this device and its device list), the `/mail/action` page, and native notifications in the desktop app through the same events.
  **nginx / README:** nothing new to proxy (`/api/*` and the `/mail/action` page already go to the app); README, `.env.example` and compose got the new settings.
- **Manual:** the operating system's own look of a push notification, and clicking one (Windows, Linux, the desktop app). The e2e checks the decrypted payload, including its link.
- Tests: shared +31 (mentions, resolution matrix, quiet hours), server +29 (`notifications.test.ts`: acceptance, mutes, edits, inbox, settings, push with a fake push service, email batching and links, a counter property test, who-may-be-told agreement) plus the migration test, web e2e +4 (`notifications.e2e.mjs`).
