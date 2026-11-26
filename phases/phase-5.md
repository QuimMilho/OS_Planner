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

## Result

Done. Where the build differs from the plan above, and what later phases must know:

- **Data model.** As planned, with these changes: `Invite.expiresAt` is required (every invite expires: 7 days for links, 14 for email, at most 90);
  `Invite.roleIds` is a JSON array; `JoinRequest.pending` is `1` while pending and `NULL` afterwards, with a unique key on
  `(teamId, userId, pending)`, because MySQL has no partial unique index (NULLs never collide, so any number of decided requests
  coexist with one pending); `Team.listingTags` is a nullable JSON array (NULL = none). New table `PendingInvite (userId, inviteId)`
  remembers the invite a person registered with until their address is verified.
- **One door for joining.** `TeamsService.addMember(tx, teamId, userId)` locks the team row (`SELECT … FOR UPDATE`), skips people
  already in (returns `false`) and checks the member limit, throwing the same `413 quota_exceeded` with scope `team` as storage
  does (this replaced the phase 3 `409 member_limit_reached`). Invites, the directory and request approval all go through it, so joins
  are serialised per team and the limit holds under load; the invite use is claimed with one atomic `UPDATE … WHERE uses < maxUses`
  in the same transaction, so a refused join uses nothing up.
- **Every join needs a verified address**, by every path (invite, link, directory), not only for email invites. A visitor who registers
  with a token gets a `PendingInvite`; `InvitesService.applyPending` runs wherever `claimPending` already did (sign-in, refresh,
  verify-email, reset-password) and accepts it once the address is verified. An email invite still needs that address to equal the
  invited one; a token that does not work is ignored silently at registration.
- **Roles on an invite** need the same right as assigning them by hand (*Manage roles*, strictly below your rank, no permission you
  lack) and are checked again when somebody accepts: an inviter who has left, or lost the right, no longer lends the role. A removed or
  banned inviter's open invites are revoked. `projectId` is limited to **top-level** projects (a sub-project would also need its
  parent's membership, which would hand out access the inviter may not have): 422 `project_must_be_top_level`.
- **Same answer for every dead token**: `404 invalid_invite` for unknown, expired, revoked, used-up, deleted-team and banned-person
  tokens, on both preview and accept (tested by comparing bodies). The two honest refusals are `403 invite_other_address` and
  `403 email_not_verified`, which only somebody holding a valid token can see. The preview also sends `Cache-Control: no-store`.
- **Bans** hide the team from that person in the directory (a banned person gets `403 banned` if they try to join by id). Banning
  removes the member, closes their pending request and drops invites they registered with. Removing or banning needs a rank above
  the target (the owner outranks everybody; `403 role_at_or_above`); the owner cannot be banned or removed (`422`).
- **Ownership transfer** needs the password (`403 invalid_password`), a target who is a member (`422 not_a_member`) and mails the new
  owner. A team created for an address that has no verified account now mails that address (`ownership offered`, in the
  administrator's language); the mail when ownership is assigned goes to the person in their own language.
- **Endpoints beyond the plan**: `DELETE /api/teams/:id/members/me` (leave), `GET /api/teams/:id/bans`, and `pendingRequests` in
  `GET /api/teams/:id/me` (counted only for people who may decide) which drives the rail badge. `POST /api/teams/:id/invites` takes
  one `email` per call (the web form sends several addresses one after another).
- **Audit actions added**: `member.add` (with `via`: invite, link or directory), `member.ban`, `member.unban`, `invite.create`,
  `invite.resend`, `invite.revoke`, `request.approve`, `request.deny`. Creating a join request is not audited (it is not a change to the
  team); `member.remove` (leave and kick) existed. Resending an email invite rotates its token (the old link stops working), because
  tokens are only stored hashed.
- **Web**: `/invite/:token` (public), `/app/directory` (compass at the bottom of the rail), team settings tabs *Invitations*,
  *Requests* (with a count), *Bans* and *Discoverability*, and per-member *Remove from team* / *Ban* plus *Leave team* or *Transfer
  ownership* (type the team name and password) at the bottom of the Members tab. Sign-in accepts `returnUrl=/invite/…`.
- **Not done / for later**: joining does not push live updates (a person approved while the page is open sees the team after a refresh
  or on regaining focus; the socket arrives with phase 6). No cooldown on asking again after a denial (a ban is the tool for that).
- The nginx proxy needed no change: the new endpoints are under `/api`, `/invite/<token>` is a page of the website on the same origin,
  and there are no new origins, upload sizes or slow endpoints.
- Tests: shared unchanged (206), server +36 (35 in `membership.test.ts`, 1 migration step), web e2e +4 (`joining.e2e.mjs`: scenarios
  10 to 13; scenario 12 also covers the deny-and-ask-again path, scenario 13 the kicked person's `revokedSpaces` and local database).
