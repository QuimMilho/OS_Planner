# Phase 5: Joining teams (invites, links, public directory)

## Goal
Get people into teams: by email invite (even before they have an account), by invite link, or from a public directory with a per-team "anyone can join" or "request to join" policy. Also leaving, removing and transferring ownership.

**Depends on:** 3 and 4 (roles in invites, audit). **Mail:** reuses the existing mail service and templates (en + pt).

## In scope / Out of scope
- In: email invites, invite links, public directory, join requests, join/leave/kick/ban, ownership transfer, pending ownership from phase 3, member/limits checks.
- Out: SSO/SCIM, bulk CSV import, invite analytics.

## Data model
```
Invite       { id, teamId, projectId?, kind: email|link, email?, tokenHash CHAR(64) UNIQUE, roleIds JSON, invitedBy, maxUses INT?, uses INT, expiresAt?, revokedAt?, createdAt, acceptedBy?, acceptedAt? }
JoinRequest  { id, teamId, userId, message, status: pending|approved|denied|withdrawn, decidedBy?, decidedAt?, createdAt }   unique pending per (teamId, userId)
Ban          { teamId, userId, reason, bannedBy, createdAt }     PK (teamId, userId)
```
- Team already has `isPublic` and `joinPolicy` (phase 3); add `listingBlurb`, `listingTags JSON` for the directory.
- Tokens are 32 random bytes, stored hashed, shown once. Link tokens are shorter-lived by default (7 days), email invites 14 days.

## API
- Invites (`CREATE_INVITES`): `POST /api/teams/:id/invites {email? | link:true, roleIds?, projectId?, maxUses?, expiresInDays?}`; `GET /api/teams/:id/invites`; `DELETE /api/invites/:id` (revoke); `POST /api/invites/:id/resend`.
- Public preview (no login): `GET /api/invites/preview?token=` → team name/icon/member count only; never the member list. Rate-limited.
- Accept: `POST /api/invites/accept {token}` (login required). Email invites require the account's verified email to equal the invited address (case-insensitive), unless the token was issued as a link.
- Registration with an invite: `POST /api/auth/register {…, inviteToken}` creates the account and accepts the invite after verification of the email address; existing `verify-email` flow unchanged. The invite mail links to `APP_URL/invite/<token>` which routes to register or login and returns to acceptance.
- Directory: `GET /api/directory?q=&tag=&cursor=` (public teams only, login required), `GET /api/directory/:slug`.
- Join: `POST /api/teams/:id/join` (policy `open` → member at once with default roles; `request` → creates a `JoinRequest`). `DELETE /api/teams/:id/join-request` (withdraw). Requests: `GET /api/teams/:id/join-requests`, `POST …/:rid/approve|deny` (`MANAGE_MEMBERS`).
- Membership: `DELETE /api/teams/:id/members/me` (leave), `DELETE /api/teams/:id/members/:userId` (kick), `PUT/DELETE /api/teams/:id/bans/:userId`, `POST /api/teams/:id/transfer-ownership {userId}` (owner only, confirm by password).
- Pending owner: on registration/verification, `PendingOwner` rows for that email are turned into ownership and the user is notified.

## Web UI
- `/invite/:token` page: shows the team (name, icon, members count) → "Create account to join" / "Sign in to join" / "Join". Works for logged-out visitors; remembers the token through registration and email verification.
- Team settings → **Invites**: create link (expiry, max uses, default roles), create email invites (multiple addresses), list with status, revoke/resend.
- **Directory** (rail → Browse): search, tags, cards with Join / Request. Team settings → **Discoverability**: public toggle, policy, blurb, tags.
- Team settings → **Requests** (badge in the rail for people with `MANAGE_MEMBERS`) and **Bans**.
- Leave team, transfer ownership (type the team name to confirm).
- Emails: invite, request approved/denied, ownership assigned (en + pt).

## i18n keys
`invite.*`, `directory.*`, `join.open|request|requested|withdraw`, `requests.*`, `bans.*`, `ownership.transfer.*`, `mail.invite.*`, `mail.requestDecision.*`, `mail.ownership.*`.

## Security & permissions
- Tokens hashed, constant-time compare, single use for email invites, `uses < maxUses` checked atomically (`UPDATE … SET uses = uses + 1 WHERE uses < maxUses`).
- Preview endpoint leaks only name, icon and count; throttled; a revoked/expired token gives the same response as an unknown one.
- Banned users cannot join by any path; the ban message does not reveal moderator identity.
- Email invites never confirm whether an address has an account.
- Public directory lists only teams with `isPublic`; private teams never appear, even by search of exact name.
- Joining respects `MAX_MEMBERS_PER_TEAM` (quota override) and is audited (`invite.*`, `member.*`).

## Quota impact
Member count limit per team (`maxMembers` override). A user's own quota is unaffected.

## Implementation steps
1. Models + migration; token helpers (reuse `common/crypto.ts`).
2. Invite service (create/preview/accept/revoke), registration hook, `PendingOwner` application.
3. Directory + join policy + requests.
4. Leave/kick/ban/transfer with last-owner rules.
5. Mail templates (en/pt) and `/invite/:token` route; UI pages.
6. Audit entries; docs.

## Acceptance criteria
1. [server] Link invite: max uses 2 → third accept fails with a generic "invalid invite"; concurrent accepts never exceed `maxUses` (parallel test).
2. [server] Expired, revoked, used (email) and unknown tokens return the same status and body.
3. [server] An email invite to `x@example.com` cannot be accepted by an account whose verified email differs; accepted after the right account verifies.
4. [server] Registration with `inviteToken` for an address without an account creates the user, and after email verification the user is a member with the invited roles; before verification they are not.
5. [server] `PendingOwner`: the named email registers and verifies → becomes owner; the admin who created it is not a member unless invited.
6. [server] Directory returns only public teams; private team slug lookup is 404; `open` policy joins immediately; `request` creates a pending request; approve/deny need `MANAGE_MEMBERS`; withdrawing works; duplicate pending requests are impossible.
7. [server] Banned users are refused by invite, link, directory and requests; unbanning restores access.
8. [server] The owner cannot leave without transferring; transfer requires the password; the previous owner keeps their roles but loses owner bypass.
9. [server] Limits: the `(max members)+1`th join returns 413-style `quota_exceeded` with scope `team`.
10. [web e2e] Admin makes team T with owner A; A invites `new@example.com`; the mail (Mailpit) link opens `/invite/…`, the visitor registers, verifies, and lands in T with the invited role.
11. [web e2e] Invite link used by a logged-out visitor with an existing account: sign in → joined; the link shows no member names before login.
12. [web e2e] Public "request to join" team: C requests, A approves, C sees the team without reload (page refresh until phase 6); a denied request shows the neutral state and C can ask again later.
13. [web e2e] Leave team: the team disappears from the rail and from Dexie on next sync; kicked users get `revokedSpaces`.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).
