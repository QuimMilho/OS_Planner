# Phase 16: Voice and video channels

## Goal
Voice (and optionally video and screen sharing) channels in teams and projects, gated by the same permission system. The feature is optional: it needs a media server (LiveKit) and is hidden when none is configured, so a plain install stays small.

**Depends on:** 4, 6, 7 (channels). Phase 13 can link a meeting to a voice channel.

## In scope / Out of scope
- In: voice channel type, join/leave with permission checks, mute/deafen, camera, screen share, participant list with speaking indicator, moderator actions (server mute, move, disconnect), per-channel limits, optional LiveKit service in compose, Electron/PWA media permissions, audit entries.
- Out: recording, transcription, stage/webinar mode, voice in DMs, a built-in TURN server (LiveKit's embedded TURN is documented), mobile apps.

## Design
- **SFU**: LiveKit server (Apache-2.0). Configuration: `LIVEKIT_URL` (public `wss://…`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, optional `LIVEKIT_WEBHOOK_URL`. Compose profile `voice` runs `livekit/livekit-server` and documents the UDP/TCP ports and TLS. Without these variables `GET /api/features` reports `voice:false` and the UI shows no voice option.
- **Tokens**: the OS_Planner server issues a short-lived (10 min) LiveKit access token per join: `roomName = channelId`, identity = user id, name = nickname, grants derived from effective permissions: `roomJoin` needs `CONNECT`; `canPublish` audio needs `SPEAK`; camera needs `VIDEO`; screen share needs `SCREEN_SHARE`; `canSubscribe` always. Metadata: colour, avatar.
- **Presence in voice**: LiveKit webhooks (`participant_joined|left`, signature verified) update a `VoiceParticipant` projection and emit `voice.participants` to room `channel:<id>` so members see who is in a voice channel without joining.
- **Moderation**: `MUTE_MEMBERS` (server-mute/unmute a participant's microphone), `MOVE_MEMBERS` (move between voice channels they can both see), disconnect via kick (`MANAGE_CHANNELS` or `MOVE_MEMBERS`) using the LiveKit server API; every action audited.
- **Permission changes** while connected (role change, overwrite, removal) call LiveKit `updateParticipant` permissions or remove the participant within seconds (driven by `permissions.changed` events from phase 6).
- **Client**: `livekit-client` loaded lazily; `VoiceService` (signals): connect/disconnect, devices (mic/camera/speaker selection, remembered per device), mute/deafen, push-to-talk option, noise suppression toggles, speaking detection, reconnect handling. One active voice connection at a time; leaving the page keeps it (floating mini-bar).

## Data model
```
Channel.kind adds 'voice' (phase 7) with Channel.userLimit INT?, Channel.bitrate? (audio quality preset)
VoiceParticipant { channelId, userId, joinedAt, mutedByModerator BOOL, source: webhook }    projection, pruned on leave and on server restart sync
```
Messages for a voice channel's text chat are out of scope (the channel has an optional linked text channel).

## API
- `GET /api/features` → `{voice, push, collab, …}` capability flags (used to hide UI).
- `POST /api/channels/:id/voice/token` → `{ url, token, expiresAt }` (404 if no `VIEW_CHANNEL`, 403 without `CONNECT`, 409 `channel_full`).
- `POST /api/channels/:id/voice/participants/:userId/mute|unmute|move|disconnect`.
- `POST /api/voice/webhook` (LiveKit → server; HMAC verified; not authenticated otherwise; rate limited).
- Events: `voice.participants`, `voice.moderated`.

## Web UI
- Voice channels in the sidebar list with live participant avatars underneath; click to join.
- Voice bar (bottom of the sidebar): channel name, connection quality, mute, deafen, camera, share screen, leave, settings; floating mini-bar when navigating.
- Voice view: grid of participants (video tiles/avatars), speaker highlight, pin/focus a tile, screen share full view, participant menu for moderators.
- Settings → Voice & video: devices, input volume, noise suppression, push-to-talk key, test microphone.
- Browser permission handling with friendly guidance when blocked; the Electron shell adds the media permission handler (`media`, `display-capture`) **only for the OS_Planner origin** and uses `desktopCapturer` for screen source selection.

## i18n keys
`voice.*` (join, leave, mute, deafen, camera, share, channelFull, noPermission, devices, quality), `voice.admin.*`, `errors.voiceUnavailable`.

## Security & permissions
- Tokens are scoped to one room and expire quickly; secrets stay server-side; `LIVEKIT_API_SECRET` ≥ 32 chars validated at startup when voice is enabled.
- Permission checks happen on token issue and again on any permission change; LiveKit is never trusted to decide access.
- Webhook signature verified (`Authorization` JWT from LiveKit); replayed/old events ignored.
- Electron: permission handler allows only the OS_Planner origin; `setDisplayMediaRequestHandler` shows a picker; nothing else changes in the sandbox.
- CSP: `connect-src` and `media-src` gain the LiveKit origin (`wss`) when configured; documented for static hosting (phase 0 rule).
- Privacy: no recording; the UI shows when the camera/mic/screen is active.

## Quota impact
No stored bytes. Limits: maximum participants per channel (`userLimit`, server default `VOICE_MAX_PARTICIPANTS=25`) and per-team concurrent voice participants (`maxVoiceParticipants` override) as a cost/safety guard.

## Implementation steps
1. Feature flags endpoint; compose profile and env validation.
2. Token endpoint with permission mapping; webhook projection; events.
3. Moderation endpoints and permission-change enforcement.
4. Client `VoiceService`, UI, device settings, mini-bar.
5. Electron permissions + desktop smoke test.
6. Docs (ports, TLS, NAT/TURN notes).

## Acceptance criteria
1. [server] Token endpoint: no `VIEW_CHANNEL` → 404; no `CONNECT` → 403; full channel → 409; grants reflect `SPEAK`/`VIDEO`/`SCREEN_SHARE` exactly (decoded JWT test); expiry 10 min; feature off → 404 and `voice:false`.
2. [server] Webhook: invalid signature rejected; join/leave events update the projection and emit `voice.participants`; duplicate and out-of-order events are idempotent.
3. [server] Moderation: `MUTE_MEMBERS`/`MOVE_MEMBERS` required; hierarchy rules apply (cannot moderate someone with a higher role or the owner); each action writes an audit entry.
4. [server] Revoking `CONNECT` or removing a member disconnects them (LiveKit API called with the right identity) within 5 s (stubbed LiveKit server API in tests).
5. [web e2e, with a local LiveKit container in CI profile `voice`] Two users join one voice channel with fake media devices (`--use-fake-device-for-media-stream`), see each other's tile and speaking indicator; mute works; the participants list in the sidebar updates for a third user who is not connected.
6. [web e2e] A user without `SPEAK` joins muted and cannot unmute; a moderator server-mutes and the participant sees the reason; moving a participant works.
7. [web e2e] Screen share starts and appears for the other participant (Chrome's auto-select flag in test); leaving ends it.
8. [web e2e] With voice not configured, no voice UI is visible and the API reports the feature off.
9. [desktop] The Electron window grants microphone/display capture only to the OS_Planner origin and refuses another origin (unit test on the permission handler + smoke test).
10. [manual] Real devices (headset, webcam), network change recovery, behind a typical NAT with the documented ports.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).

## Result

**Update (phase 17, 2026-11-27): the real-media browser tests ran and pass** (4 of 4 with `livekit/livekit-server` in Docker). They found one bug: a voice channel opened by its address before the device had loaded that channel's team (a new member, a new device) showed an empty page, because the chat store keeps a fetched channel only once its team is known; the voice page now uses the fetched channel itself. Only acceptance 10 (manual) is still open. The original note follows.

Built and tested, with one open item: **the browser tests that need a real media server (acceptance 5, 6 and 7) are written (`apps/web/e2e/voice.e2e.mjs`, `describe('voice')`) but have not been run**. Docker Desktop could not start any new container on 2026-11-27 (even `hello-world` hung), so there was no LiveKit to talk to. They skip themselves without docker or the `livekit/livekit-server` image (and with `E2E_NO_VOICE=1`). Everything around them ran: the server (token, webhook, moderation, enforcement) against a stand-in for LiveKit's room API, the website's voice screens against a server whose media server is unreachable, voice off, and the desktop shell. Run `npm run e2e` once Docker can start containers (it creates and removes its own `os-planner-e2e-livekit`; ports 7880–7882 must be free) before calling the phase finished.

Where the build differs from the plan above, and what later phases must know:

- **No LiveKit SDK on the server.** Access tokens are plain HS256 JWTs signed with `jose`, webhooks are verified the same way (JWT in `Authorization`, its `sha256` claim is compared with the hash of the raw body), and the room API (`RemoveParticipant`, `UpdateParticipant`, `MutePublishedTrack`, `ListParticipants`, `ListRooms`, `DeleteRoom`) is LiveKit's Twirp JSON over `fetch` (`apps/server/src/voice/livekit.service.ts`). One small class, nothing to keep in step with the SDK, and the tests stand a fake server in its place. The web client does use `livekit-client` (a lazy chunk of ~613 kB; the initial bundle stays 2.15 MB of 2.2 MB).
- **Settings.** `LIVEKIT_URL` (public `ws(s)://`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (≥ 32, all or none, checked at start-up), plus `LIVEKIT_API_URL` (where the server reaches LiveKit's API; default `LIVEKIT_URL` with `http(s)`), `VOICE_MAX_PARTICIPANTS` (25), `VOICE_TEAM_MAX_PARTICIPANTS` (100) and `VOICE_CHECK_SECONDS` (30). `LIVEKIT_WEBHOOK_URL` is **not** read by the server: it is only the compose variable that tells the LiveKit container where to send webhooks. `voiceEnabled(env)` / `voiceOrigins(env)` in `config/env.ts`; `GET /api/features` (public) answers `{voice, push, collab}`.
- **Data.** Migration `voice`: `Channel.userLimit`, `Channel.quality` (`low|normal|high`; the plan said `bitrate`), `QuotaOverride.maxVoiceParticipants` (the per-team cap; set with `PUT /api/admin/quotas/team/:id`, not in the Administration screen), table `VoiceParticipant` (primary key channel + user, so one connection of a person per channel; `sid`, `mutedByModerator`, `grants` = what the media server was told, `eventAt`). A migration test covers it (`only('voice')`).
- **Projection.** The webhook handler is idempotent and tolerates reordering: a reconnect has a new `sid`, so a late "left" of the old connection changes nothing, and a "joined" that arrives after its own "left" is dropped (a small in-memory memory of ended connections); replayed events (event id seen, or older than 10 minutes) are ignored. A joined person is checked again (permission, archive, channel limit, team limit) and removed from the room if any fails, so the limits hold even when two people got a token at once. `reconcile()` (at start-up, then every `VOICE_CHECK_SECONDS`) compares the table with `ListRooms`/`ListParticipants`: ghosts leave the list, people the webhooks missed are added.
- **Enforcement.** `VoiceService.enforce()` runs on `permissions.changed`, `membership.changed`, `team.audited` and the new `channel.changed` (published after a voice channel is updated or deleted), and as the periodic backstop: whoever lost CONNECT, the channel or the team is removed (the row goes only after LiveKit confirmed, so a media server that is down is retried), whoever gained or lost SPEAK/VIDEO/SCREEN_SHARE gets `UpdateParticipant` (and the microphone track muted). The calls run before the changing request answers (events are awaited), so "within 5 seconds" is in practice immediate; the test asserts it.
- **Moderation.** Rules are the pure `checkModeration` in `@os-planner/shared` (the web hides what it would refuse): mute/unmute need MUTE_MEMBERS, move MOVE_MEMBERS (also in the destination), disconnect MOVE_MEMBERS or MANAGE_CHANNELS; never the owner or oneself, only people ranked strictly below, only an administrator moderates an administrator. A server mute removes the microphone from the person's allowed sources and sets the participant attribute `modMuted`, so they cannot unmute until someone with MUTE_MEMBERS allows it (it lasts while they stay in the channel; the row goes when they leave). **Move** is done by the person's own browser (it receives `voice.moderated` with the destination and joins it with a fresh token, which checks CONNECT there); the server takes them out of the old room after 8 seconds if they have not left. Audit actions `voice.mute|unmute|move|disconnect` (texts in en and pt).
- **Events.** `voice.participants` (room `channel:<id>`, the whole list; the room of a voice channel is joinable by whoever can see it, and the sidebar joins it for every voice channel of the active team together with the text channels) and `voice.moderated` (room `user:<id>`). `GET /api/teams/:id/voice` and `GET /api/channels/:id/voice` give the same list over REST.
- **Web.** `data/voice-service.ts` (`VoiceService`: connect, devices, mute, deafen, camera, screen, push to talk, input volume through a small Web Audio processor, reconnect with a new token up to three times, reactions to `voice.moderated`), `data/voice-prefs.ts` (per device), `data/voice-store.ts` (who is in each channel), `data/features.ts` (flags, cached on the device), `features/voice/` (call bar, call page at `/app/v/:channelId`, Settings → Voice and video). Joining a second channel leaves the first. The sidebar row of a voice channel joins on click. Not in the plan: a participant tile can be pinned, the person gets a guidance line when the browser blocks the microphone, camera or screen (they can still listen), and a person without SPEAK is told they can only listen.
- **Defaults.** CONNECT and SPEAK are **not** in `DEFAULT_EVERYONE` (stored roles of existing teams could not get them anyway); a team gives them to a role. The README says so.
- **Proxy and CSP.** `connect-src` and `media-src` gain the media server's `ws(s)://` and `http(s)://` origin; `app.setup.ts` reads the webhook as raw bytes (`application/webhook+json`). `deploy/nginx/os-planner-voice.conf.template` (mounted by the `proxy` profile; `OS_PLANNER_LIVEKIT_DOMAIN`, default `voice.invalid`, resolves LiveKit lazily) forwards the media server's own host name; docker compose has the `voice` profile (`livekit`) and the `LIVEKIT_*` variables of `server`. Audio and video cannot pass through nginx: the README lists the ports. Neither the compose file nor the nginx template could be run (Docker could not start containers); both were only read through.
- **Electron.** `apps/desktop/src/permissions.ts` (`mayUse`, unit-tested in `e2e/permissions.e2e.mjs`): microphone/camera (`media`) and `display-capture` only for the OS_Planner origin, clipboard and fullscreen as before, everything else refused; `setDisplayMediaRequestHandler` opens a menu of screens and windows (`desktopCapturer`), a closed menu refuses. A smoke test in `desktop.e2e.mjs` checks the permission check for the site (granted) and for the same server under another name (not granted). The picker itself was not exercised automatically.
- **Not done:** the optional text channel linked to a voice channel (a voice channel has none; use a text channel next to it), a link from a calendar meeting to a voice channel in the UI (the API accepts `linkedChannelId`; phase 13 left the UI out), `LIVEKIT_WEBHOOK_URL` in the server's own settings (see above), the team cap in the Administration screen, acceptance 10 (manual: real headset, webcam, network change, NAT) and acceptance 5–7 as run tests (see the first paragraph).
- **Tests.** shared +5 (`permissions/voice.test.ts`), server +16 (`voice.test.ts` 15, `voice-off.test.ts` 1) +1 (migration), web e2e: `voice.e2e.mjs` (4 with a real media server, not run; 1 without a reachable media server; 1 with voice off), desktop +4 (3 unit + 1 smoke).
