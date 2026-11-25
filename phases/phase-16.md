# Phase 16: Voice and video channels

## Goal
Voice (and optionally video and screen sharing) channels in teams and projects, gated by the same permission system. The feature is optional: it needs a media server (LiveKit) and is hidden when none is configured, so a plain install stays small.

**Depends on:** 4, 6, 7 (channels). Phase 13 can link a meeting to a voice channel.

## In scope / Out of scope
- In: voice channel type, join/leave with permission checks, mute/deafen, camera, screen share, participant list with speaking indicator, moderator actions (server mute, move, disconnect), per-channel limits, optional LiveKit service in compose, Electron/PWA media permissions, audit entries.
- Out: recording, transcription, stage/webinar mode, voice in DMs, a built-in TURN server (LiveKit's embedded TURN is documented), mobile apps.

## Design
- **SFU**: LiveKit server (Apache-2.0). Configuration: `LIVEKIT_URL` (public `wss://…`), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, optional `LIVEKIT_WEBHOOK_URL`. Compose profile `voice` runs `livekit/livekit-server` and documents the UDP/TCP ports and TLS. Without these variables `GET /api/features` reports `voice:false` and the UI shows no voice option.
- **Tokens**: the Notes server issues a short-lived (10 min) LiveKit access token per join: `roomName = channelId`, identity = user id, name = nickname, grants derived from effective permissions: `roomJoin` needs `CONNECT`; `canPublish` audio needs `SPEAK`; camera needs `VIDEO`; screen share needs `SCREEN_SHARE`; `canSubscribe` always. Metadata: colour, avatar.
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
- Browser permission handling with friendly guidance when blocked; the Electron shell adds the media permission handler (`media`, `display-capture`) **only for the Notes origin** and uses `desktopCapturer` for screen source selection.

## i18n keys
`voice.*` (join, leave, mute, deafen, camera, share, channelFull, noPermission, devices, quality), `voice.admin.*`, `errors.voiceUnavailable`.

## Security & permissions
- Tokens are scoped to one room and expire quickly; secrets stay server-side; `LIVEKIT_API_SECRET` ≥ 32 chars validated at startup when voice is enabled.
- Permission checks happen on token issue and again on any permission change; LiveKit is never trusted to decide access.
- Webhook signature verified (`Authorization` JWT from LiveKit); replayed/old events ignored.
- Electron: permission handler allows only the Notes origin; `setDisplayMediaRequestHandler` shows a picker; nothing else changes in the sandbox.
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
9. [desktop] The Electron window grants microphone/display capture only to the Notes origin and refuses another origin (unit test on the permission handler + smoke test).
10. [manual] Real devices (headset, webcam), network change recovery, behind a typical NAT with the documented ports.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).
