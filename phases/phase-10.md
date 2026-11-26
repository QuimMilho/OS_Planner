# Phase 10: Shared notebooks and share links

## Goal
Notebooks that belong to teams and projects (gated by roles and overwrites) and private notebooks that can be shared directly with people (read or edit) or by link (read anonymously, edit with a login).

**Depends on:** 3, 4 (permissions), 6 for live updates. **Needed by:** 11, 15.

## In scope / Out of scope
- In: notebooks in team and project spaces, per-notebook overwrites, a "Shared with me" area, direct shares, share links (read/edit, expiry, password, revoke), anonymous read view, share-scoped media access, sync across spaces, trash and export in shared spaces.
- Out: page-level sharing (the unit is the notebook), comments/suggestions mode, public indexing/SEO of shared pages.

## Data model
- `Notebook.spaceId` already exists (phase 3). New permission use: `VIEW_NOTEBOOKS`, `CREATE_NOTEBOOKS`, `EDIT_PAGES`, `DELETE_PAGES`, `MANAGE_NOTEBOOKS`, `SHARE_NOTEBOOKS`. Overwrites can target a notebook (`targetKind=notebook`).
```
NotebookShare { id, notebookId, userId, access: read|edit, createdBy, createdAt }                 unique (notebookId, userId)    // private notebooks only
ShareLink     { id, notebookId, tokenHash CHAR(64) UNIQUE, access: read|edit, passwordHash?, expiresAt?, revokedAt?, createdBy, createdAt, lastUsedAt? }
```
- Sharing applies to **personal-space** notebooks. Team/project notebooks are governed by roles and overwrites; a team notebook may also get a *read* link when the actor holds `SHARE_NOTEBOOKS` and the team allows public links (`Team.allowPublicLinks`, default false).
- Sync: a notebook shared directly appears for the recipient as part of a *virtual* space entry `shared:<ownerSpaceId>` in their cursors (`sharedNotebooks`), with `revokedSpaces`-style removal when the share ends. Content is fetched like their own pages; quotas still charge the owner.

## API
- Team/project: `GET/POST /api/spaces/:id/notebooks` (existing endpoints with space scope), move a notebook between spaces (`POST /api/notebooks/:id/move {spaceId}`; requires create rights on the target and `MANAGE_NOTEBOOKS` on the source; media is re-attributed and quota recomputed).
- Direct shares: `GET /api/notebooks/:id/shares`, `PUT /api/notebooks/:id/shares {userId|email, access}` (email of a non-user sends an invite mail that grants the share after registration), `DELETE …/:shareId`. `GET /api/shared-with-me`.
- Links: `POST /api/notebooks/:id/links {access, expiresInDays?, password?}`, `GET …/links`, `DELETE /api/links/:id`, `PATCH /api/links/:id` (expiry/password). The URL shown is `APP_URL/s/<token>` (phase 0 rule 3).
- Link access: `POST /api/links/resolve {token, password?}` → `{notebook, access, tree}` (anonymous allowed for read; edit requires login); `GET /api/links/:token/pages/:id`, `GET /api/links/:token/media/:id` (served with `Content-Disposition` rules like media). An edit link used by a logged-in user *adds the notebook to their Shared-with-me* as an `edit` share bound to the link (revoked with it).
- Anonymous endpoints are rate limited and never expose user ids or email addresses (authors shown by display name only, and a setting per link `showAuthors`).

## Web UI
- Notebook context menu → **Share**: dialog with *People* (search by name/email, access dropdown) and *Link* (create/copy/revoke, read or edit, expiry, password), plus "Who has access" list.
- Sidebar: **Shared with me** section (read/edit badges), team/project sections show their notebooks; permission-aware controls (read-only pages disable the editor and show a banner).
- `/s/:token` page: public read-only reader (tree sidebar, search within the notebook, print/PDF export when the link allows), password prompt, "Sign in to edit" for edit links; layout works without the app shell and without Dexie.
- Offline: shared and team notebooks sync like private ones (content cached on demand); read-only roles never queue writes.
- Notebook "Move to…" picker (personal ↔ team ↔ project) with a warning about who will gain or lose access.

## i18n keys
`share.*` (people, link, access read/edit, expiry, password, revoke, copy, whoHasAccess), `sharedWithMe.*`, `publicView.*`, `notebook.move.*`, `errors.linkInvalid` (one message for expired, revoked, unknown).

## Security & permissions
- Link tokens: 32 random bytes, hashed; constant-time compare; revocation and expiry checked on every request; invalid → identical 404.
- Passwords: argon2id, attempt throttling per link and IP; the password is exchanged for a short-lived link-scoped JWT (read-only unless the link is edit and the user logged in).
- Anonymous read exposes only the notebook in the link; it can never reach another notebook, the owner's other data, search across spaces, or user profile endpoints. Media served via link-scoped tokens only for media referenced by that notebook's pages.
- `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex` on `/s/*`; CSP unchanged; no third-party scripts.
- An edit permission obtained through a link ends when the link is revoked, even mid-session (checked on each write and by the co-editing server in phase 11).
- Direct shares to unregistered emails do not reveal account existence.

## Quota impact
Content created in a shared personal notebook charges the **notebook owner's personal quota**; content in team/project notebooks charges that space. Moving a notebook moves its usage in one transaction (refused if the target lacks room).

## Implementation steps
1. Space-aware notebook endpoints and permission checks; overwrites for notebooks.
2. Sync for shared notebooks and revocation; Dexie `shared` table.
3. Share and link models, services, throttling, email invite for unregistered shares.
4. Public reader route and link-scoped media tokens.
5. Share dialog, Shared-with-me section, read-only editor mode, move dialog.
6. Docs.

## Acceptance criteria
1. [server] Notebook endpoints: allowed / denied / not-a-member (404) matrix for team notebooks per bit (`VIEW`, `CREATE`, `EDIT_PAGES`, `DELETE_PAGES`, `MANAGE`); read-only members cannot PUT content.
2. [server] Direct share: recipient reads (read) or edits (edit); revoke removes access and the notebook appears in `revokedSpaces`-style removal on their next sync; owner's quota is charged for the recipient's edits.
3. [server] Share link: anonymous read works; anonymous edit is refused (401); expired/revoked/unknown tokens give identical responses; wrong password throttled after N attempts.
4. [server] Anonymous requests cannot read another notebook, list users, or fetch media not referenced by the notebook; `showAuthors=false` hides names.
5. [server] Revoking an edit link blocks the next write from a user who used it.
6. [server] Moving a notebook personal → team re-attributes pages and media, recomputes both quotas atomically, is refused when the target lacks permission/space, and leaves shares/links disabled (documented rule: shares do not follow a move).
7. [web e2e] A shares notebook with B (edit) by name; B sees it under Shared with me and edits; A changes B to read → B's editor becomes read-only live; A removes B → it disappears.
8. [web e2e] A creates a read link; a logged-out browser context opens `/s/<token>`, browses the tree, searches, sees media; no app shell, no API calls beyond the link endpoints; revoking the link makes the next navigation show the generic invalid-link page.
9. [web e2e] Edit link: logged-out visitor is asked to sign in, then can edit; the change reaches A; password-protected link prompts and accepts only the right password.
10. [web e2e] Team notebook: member with `VIEW_NOTEBOOKS` only sees it read-only; with `EDIT_PAGES` edits; denied via overwrite → 404 page.
11. [web e2e] Offline: shared notebook opened before going offline stays readable; a read-only share queues no writes.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases).

## Result

Done. Where the build differs from the plan above, and what later phases must know:

- **One check for everything: `PermissionService.notebookAccess(userId, notebookId)`** (and `requireNotebook`). It answers from the *space* (the person's own space: everything; a team or
  project: the container's permissions with the notebook's own overwrites applied as one more level) or from a *share* (`permissionsForShare`: read = `VIEW_NOTEBOOKS`, edit =
  view + `EDIT_PAGES` + `DELETE_PAGES`). Notebooks, categories, pages, search, export, files and sync all go through it, so a notebook someone cannot see is a 404 in all of them.
  **A new endpoint that reads or writes notebook content must use it (never `requireSpace` on `spaceId` alone).** `requireSpace` is still right for "create a notebook in this space".
- **Notebook overwrites**: `targetKind: 'notebook'` works for team/project notebooks (changing them needs `MANAGE_NOTEBOOKS` there; you cannot allow or deny what you lack); a personal
  notebook answers 422 (it is shared with people instead). Rows are removed when the notebook is purged, when a member leaves, and on a move.
- **Sync** (deviations): a shared notebook has its own cursor `shared:<notebookId>` (not `shared:<ownerSpaceId>`): the owner's sequence, filtered to that notebook, so sharing needs no
  re-stamping of rows. `GET /api/sync/changes` always lists `sharedNotebooks` and answers every one of them (cursor 0 for a new one); a `shared:` key the client holds for a share that
  ended, or whose notebook was trashed, comes back in `revokedSpaces`. `SpaceChangesDto.hiddenNotebooks` (notebooks an overwrite hides: left out, and dropped on the device; when one stops being
  hidden the client reads the space from 0 again) and `movedOut` (from the new `NotebookMove` table: notebooks that left the space; dropped only if still filed under it). The `space:<id>`
  room also admits somebody a notebook of that space is shared with (they hear *that* it changed, nothing more).
- **Direct shares**: `PUT /api/notebooks/:id/shares {userId|email, access}`. A `userId` is accepted only for somebody who shares a team with the owner (else 404, so ids cannot be probed); an
  address answers `{ok:true}` whether or not it has an account, and one without a *verified* account becomes a `PendingShare` applied on verification/sign-in (`AuthService.claimJoins`).
  The owner's list does show an existing person by name afterwards (documented: account existence is not hidden from the person who typed the address, only from the response).
  Limits: 100 shares and 20 live links per notebook. Recipients may leave (`DELETE /api/shared-with-me/:notebookId`).
- **Links**: tokens are 32 random bytes, stored as SHA-256 only (so the address can only be shown when it is created). Public routes (`POST /api/links/resolve`, `GET /api/links/:token/{pages/:id,media/:id,search}`) take the
  token in the path and, for a password link, the `session` the resolve answer handed out (`?s=`, a 2-hour JWT bound to that link). The wrong-password counter (5 per link and address per 15 min,
  `429 too_many_attempts`) is **in memory** (a restart or a second instance only resets it; it never grants access) and counts the address Express sees: behind a proxy set `TRUST_PROXY`.
  `POST /api/links/join` (login and verified email required, 401 otherwise) turns an edit link into an edit `NotebookShare` bound to the link; revoking deletes those shares and tells the people. Somebody who already had direct edit keeps it.
  Team notebooks: read links only, only while `Team.allowPublicLinks` (checked on every request, so switching it off closes what was made); creating/revoking them is written to the team's audit log (`notebook.link.create`, `notebook.link.revoke`, `notebook.move`).
- **Move** (`POST /api/notebooks/:id/move {spaceId}`): `MANAGE_NOTEBOOKS` on the source, `CREATE_NOTEBOOKS` on the target; both spaces are locked in id order, the old one is refunded before the new one is charged (a move inside one team never fails for lack of room), pages and
  the files they use change space, shares/links/pending shares/overwrites end. A file used by pages of two notebooks makes it `409 media_shared_with_other_notebook` (no copy is attempted).
- **Files**: `POST /api/media` takes an optional `notebookId` (the notebook the file is for): the space comes from the notebook, so an editor's uploads in a shared notebook are the owner's, and uploads into a team notebook now land in the team's space (before this phase the web
  app always sent them to the person's own space). A file is served to a share recipient only if a live page of a shared notebook uses it (or they uploaded it themselves into one they may edit).
- **Web**: the sidebar shows **Shared with me** (read/edit badges) under the person's notebooks and the team's/project's **Notebooks** in the team sidebar, all through one `Tree` component (`spaceId` / `shared` inputs) whose menus follow `AccessStore.can(notebookId, bit)` (own notebook: always; otherwise the
  last `GET /api/notebook-permissions` answer kept in `meta`, refreshed every sync cycle; unknown = read-only). The editor turns read-only live (banner `data-read-only`, no toolbar, nothing queued: `onEdit`/`onTitle` return early). Dialogs: **Share…** (People/Link), **Move to another space…**, **Who can see this…**
  (the overwrite editor with `kind="notebook"`), team setting **Allow public links**. `/s/:token` is a standalone page (own header, tree, search, print, password prompt) that talks to the link endpoints with plain `fetch` (no cookies, no refresh, no Dexie); `AuthStore.init()` skips the sign-in check on `/s/…` and `resume()` does it only when the visitor asks to edit
  (`returnUrl` now also accepts `/s/…`). The trash page lists what the person may restore in team and shared notebooks too. **Initial bundle** 2.12 MB (error budget 2.2 MB): the second language is still the planned lazy-load for phase 17.
- **Not done / for later**: page-level sharing, comments and suggestions (out of scope); the team *trash* is only reachable through the trash page; shared-notebook content created by a user who is later deleted cascades with the account (there is no account deletion yet, phase 17 must decide); two people editing one
  page still get the old version-conflict copy until phase 11 brings co-editing.
- **nginx / README**: nothing new to proxy (`/s/<token>` and `/api/links/*` go through `location /`; the server sets `X-Robots-Tag` and `Referrer-Policy` itself); the template's comment and the README say so and remind to keep `TRUST_PROXY=true`. No new environment settings.
- Tests: shared +9 (what a share allows, a notebook overwrite as a chain level, cursor keys, request bodies), server +30 (`sharing.test.ts`: the per-bit matrix, notebook overwrites, direct shares and sync, links and passwords, files, revoking mid-session, moving, the permission list; plus the migration test), web e2e +6 (`sharing.e2e.mjs`: scenarios 7-11 and a move). **Manual:** none; printing from the public page uses the browser's own print dialog.
