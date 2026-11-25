# Phase 6: Realtime infrastructure

## Goal
One authenticated, permission-aware real-time connection that every later feature uses (chat, presence, notifications, live boards/calendar, permission changes). It must work with one server instance out of the box and scale to several with Redis, and it must keep working when the API is on another origin.

**Depends on:** 3 (spaces, permissions). **Needed by:** 7, 9, 11, 12, 13, 16.

## In scope / Out of scope
- In: Socket.IO gateway, handshake auth, token refresh, room joins with permission checks, revocation when access changes, presence, `EventBus`, Redis adapter, client `RealtimeService` with reconnect/resume, health and metrics, Electron/PWA behaviour.
- Out: chat features themselves (7), push notifications (9), Yjs transport (11, own endpoint).

## Design
- **Server**
  - `RealtimeModule` with a Nest `WebSocketGateway` on path `/api/realtime`, Socket.IO v4, transports `websocket` then `polling` fallback (polling stays enabled for strict proxies).
  - CORS and cookie rules from phase 0: allowed origins = `APP_URL` ∪ `CORS_ORIGINS`.
  - Handshake: `auth: { token: <access JWT> }`; invalid → disconnect with `unauthorized`. The client sends a fresh token with the `auth:refresh` event before expiry; a socket whose token expires without refresh is disconnected.
  - Rooms: `user:<id>` (auto), `space:<id>`, `channel:<id>`, `thread:<id>`. `room:join {kind,id}` runs the same `PermissionService` as REST; on denial it answers `{ok:false}` with no information about existence.
  - **Revocation**: when membership, roles or overwrites change, the server emits `permissions.changed` to affected users and re-evaluates their room memberships (leaving rooms they can no longer view). This is driven by the same domain events as the audit log.
  - **EventBus**: services publish typed events (`message.created`, `task.updated`, `member.joined`, …). A `RealtimeBridge` maps events to rooms. Controllers never call the gateway directly.
  - **Presence**: per user `online | idle | offline` with last-seen, derived from live sockets (a user is online if any socket is). `presence.update` is delivered to the rooms of teams the person shares with the viewer, throttled (1 per 5 s per user). Idle after 5 minutes without client activity ping; users may set "invisible" in settings (appears offline).
  - **Scaling**: `REDIS_URL` set → `@socket.io/redis-adapter`; presence counters in Redis; sticky sessions not required with websocket transport, documented for polling. Unset → in-memory.
  - Limits: max 5 sockets per user, max 100 room joins per socket, payload cap 1 MB, per-socket rate limiting on client events.
  - `/api/health` gains `realtime: ok|degraded`; a counters endpoint for admins (connected sockets, rooms).
- **Client**
  - `RealtimeService` (Angular, signals): `connect()` after the session exists, `disconnect()` on sign-out; automatic reconnect with backoff and jitter; `join(room)`/`leave(room)` ref-counted; `on(event)` returns an observable; `status` signal (`connected | connecting | offline`).
  - Reconnect resumes by re-joining rooms and asking each feature to *catch up* (`since` cursor), because Socket.IO does not replay missed events.
  - Connects to `apiBase() || location.origin` (phase 0). Works inside the installed PWA and the Electron window (no extra permission needed).
  - When the page is hidden for > 60 s the socket is kept for notifications but heavy rooms are left; re-joined on focus.
- **Compose/Docs**: optional `redis` service (profile `scale`), `REDIS_URL` in `.env.example`.

## Data model
None persistent besides `User.presenceMode` (`auto | invisible`). Presence itself is ephemeral.

## API (events)
Client → server: `room:join`, `room:leave`, `auth:refresh`, `presence:activity`.
Server → client: `permissions.changed`, `presence.update`, `space.changed {spaceId, seq}`, `session.revoked`, plus feature events added by later phases (documented in each phase).

## Web UI
- A small connection indicator next to the sync indicator (connected / reconnecting / offline).
- Settings → Privacy: "Appear offline" toggle.
- Team member list shows presence dots.
- The permission store (phase 3/4) and sync service subscribe: `permissions.changed` triggers a refresh; `space.changed` triggers an immediate pull instead of waiting for the 60 s timer.

## i18n keys
`realtime.connected|connecting|offline`, `settings.privacy.invisible`, `presence.online|idle|offline`.

## Security & permissions
- No anonymous sockets. The share-link read view (phase 10) uses plain HTTP, not sockets.
- Every `room:join` re-checks permissions server-side; rooms are never trusted from the client.
- A revoked session (`logout`, password reset, "sign out other sessions") disconnects its sockets within seconds (`session.revoked`).
- Origin allowlist enforced on the handshake; messages validated with zod; unknown events dropped and counted.

## Quota impact
None (no stored bytes). Rate limits protect the server instead.

## Implementation steps
1. Gateway skeleton, auth, origin allowlist; e2e harness support (`startStack` exposes the socket URL).
2. `EventBus` + `RealtimeBridge`; room join/leave with `PermissionService`.
3. Revocation on permission/membership events; session revocation hook in auth.
4. Presence; Redis adapter and a two-instance test.
5. Client service, status UI, catch-up contract, integration with sync and permission store.
6. Docs, compose profile.

## Acceptance criteria
1. [server] A socket without a token, with a media token, or with an expired token is refused; a valid token connects; `auth:refresh` extends it; no refresh → disconnected at expiry.
2. [server] `room:join` for a space/channel the user cannot view returns `{ok:false}` identically to a non-existent room; allowed users receive events for that room only.
3. [server] Removing a member (or denying `VIEW_CHANNEL`) makes the server drop their room memberships; no event published afterwards reaches them.
4. [server] Signing out or "sign out everywhere" disconnects that user's sockets; other users unaffected.
5. [server] Handshake from an origin outside `APP_URL`/`CORS_ORIGINS` is refused.
6. [server] Presence: connect/disconnect/idle transitions, multi-socket users stay online until the last socket closes, invisible users appear offline, updates are throttled.
7. [server] Two server instances with Redis: an event published on instance A reaches a client connected to B; without Redis it does not (documented).
8. [server] Limits: the 6th socket per user is refused; oversized payloads and malformed events are dropped without crashing the gateway.
9. [web e2e] Two users: A changes B's role in the UI; B's controls update without reload (via `permissions.changed`).
10. [web e2e] Kill the server connection (`context.setOffline`) → indicator shows reconnecting; restore → reconnects and runs catch-up; no duplicate or missing events.
11. [web e2e] Website and API on different origins (`startSite`): sockets connect with the token; a stranger origin cannot.
12. [desktop] The Electron window connects and receives an event (smoke test).

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).
