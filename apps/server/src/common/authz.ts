import { SetMetadata } from '@nestjs/common';
import type { CLIENT_EVENTS, JoinableRoomKind, PermissionName } from '@os-planner/shared';

export const AUTHZ = 'authz';

/**
 * Who may call a route, declared next to it (phase 17).
 *
 * The route still enforces its own rule (the global AuthGuard, AdminGuard, the services' permission checks); this is the
 * contract the generated authorization test (`test/authz.test.ts`) holds every route to, and that test fails for a route
 * without a declaration. Scopes:
 *
 *  - `public`:   anybody, signed in or not. The answer is the same for everybody (or the route signs a person in).
 *  - `secret`:   no sign-in; a secret in the request is the key (invite, link, feed address, mail link, email token).
 *                A wrong secret answers exactly like a missing one.
 *  - `self`:     any signed-in person, about themselves (their settings, their lists). Nothing of anybody else's.
 *  - `own`:      a signed-in person, about one of their own rows named in the path (a session, a feed, a device):
 *                somebody else's row answers 404, like one that does not exist.
 *  - `admin`:    instance administrators (ADMIN_EMAILS, verified). Everybody else, signed in or not, gets 404.
 *  - `release`:  the build pipeline (bearer RELEASE_TOKEN); 404 when no token is configured.
 *  - `webhook`:  the media server (a JWT over the exact body); anything unsigned is 401.
 *  - `team`, `project`, `space`, `channel`, `notebook`, `board`, `calendar`: members of the team that holds the resource,
 *                with `needs` there. Somebody who cannot see the resource (not a member, banned, removed, an instance
 *                admin who is not a member, a member without its VIEW_* bit) gets 404; a member who can see it but lacks
 *                `needs` gets `denied` (403 unless said otherwise).
 *  - `dm`:       the two people of a direct conversation; anybody else gets 404.
 */
export type AuthzScope =
  | 'public'
  | 'secret'
  | 'self'
  | 'own'
  | 'admin'
  | 'release'
  | 'webhook'
  | 'team'
  | 'project'
  | 'space'
  | 'channel'
  | 'notebook'
  | 'board'
  | 'calendar'
  | 'dm';

export interface AuthzRule {
  scope: AuthzScope;
  /** Every one of these is needed in the scope. Empty or absent: being able to see the resource is enough. */
  needs?: readonly PermissionName[];
  /** Any one of these is enough (on top of `needs`). */
  anyOf?: readonly PermissionName[];
  /** The person who wrote or made the item: `only` = nobody else (whatever their permissions), `or` = them, or whoever holds `needs`. */
  author?: 'only' | 'or';
  /** Only the team's owner (no permission is enough). */
  ownerOnly?: boolean;
  /** What a member who can see the resource but lacks the permission gets. Default 403. */
  denied?: 403 | 404;
  /** Needs a verified email address (`403 email_not_verified` otherwise). */
  verified?: boolean;
  /** A rule the fields above cannot express. Read by the security review. */
  note?: string;
}

/** Declares who may call the route (or every route of a controller, when put on the class). */
export const Authz = (rule: AuthzRule): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHZ, rule);

/**
 * The realtime socket (/api/realtime): connecting needs a live session's access token (never a media token), at most five
 * connections per person. These are the only events a client may send; anything else is dropped unanswered.
 */
export const AUTHZ_SOCKET_EVENTS: Record<(typeof CLIENT_EVENTS)[number], AuthzRule> = {
  'room:join': {
    scope: 'self',
    note: 'only a room of AUTHZ_ROOMS the person may be in; any refusal is the same {ok:false}',
  },
  'room:leave': { scope: 'self' },
  'auth:refresh': {
    scope: 'self',
    note: 'a token of the same login; anything else ends the connection',
  },
  'presence:activity': { scope: 'self' },
};

/** Who may be in each room a client may ask for (RoomAuthorizer). `user:<id>` and `team:<id>` are joined by the server itself. */
export const AUTHZ_ROOMS: Record<JoinableRoomKind, AuthzRule> = {
  space: {
    scope: 'space',
    note: 'also whoever a notebook of the space is shared with (they hear that it changed)',
  },
  channel: { scope: 'channel', note: 'a conversation: its two people' },
  thread: { scope: 'channel' },
  board: { scope: 'board' },
};

/** Co-editing (/api/collab): a page opens for whoever may see its notebook, read-only without EDIT_PAGES. */
export const AUTHZ_COLLAB: AuthzRule = {
  scope: 'notebook',
  note: 'read-only without EDIT_PAGES (or when the page or notebook is in the trash)',
};
