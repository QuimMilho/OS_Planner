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
