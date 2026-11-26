# OS_Planner

OS_Planner is an open source, self-hosted planner: a website with notebooks, categories and pages, a rich editor (math,
diagrams, charts, function plots, code, images, video), PDF export, offline editing with sync, accounts, and teams with
projects, live updates and team chat. It runs in the browser, installs as a PWA, and is downloadable as a desktop app for Windows and Linux, **all from the website**.

```
notebook ─ category ─ nested category ─ page        every level has its own name; reorder, move, trash, restore
```

## What is in the box

| Part | What it is |
| --- | --- |
| `apps/server` | NestJS 12 + Prisma 7 + **MySQL 8.4**. Auth, notebooks/categories/pages, sync, media, search, PDF/Markdown export, release downloads, the live connection (Socket.IO) and chat. Also serves the website. |
| `apps/web` | Angular 22 PWA (zoneless, signals, Material 3). Local-first: everything reads from IndexedDB and syncs in the background. English + Portuguese. |
| `apps/desktop` | Electron shell: a native window around the website (always up to date). Windows installer/portable, Linux AppImage/deb/rpm. |
| `packages/shared` | The document schema, validation, Markdown import/export, print renderer, plot engine and DTOs used by all of the above. |

### Why the document format is not Markdown

Pages are stored as **ProseMirror/TipTap JSON**, validated against one shared schema. Markdown cannot represent
charts, diagrams, video, image size/alignment/captions, colour or complex tables without HTML hacks, and a
save would round-trip through a parser and drift. JSON is lossless and schema-checked (no raw HTML, so no stored
XSS). Markdown stays as an interchange format: import, and export of a page (`.md`) or a notebook (`.zip` with folders).

## Run it (development)

Requirements: Node 22+ (developed on 24), Docker, Google Chrome or Edge (for PDF export).

```bash
cp .env.example .env              # then set JWT_ACCESS_SECRET / JWT_MEDIA_SECRET (>= 32 chars)
docker compose up -d mysql mailpit
npm install
npm run build -w @os-planner/shared
npm run prisma:migrate -w @os-planner/server

npm run start:dev -w @os-planner/server      # API on :3000
npm run start -w @os-planner/web             # website on :4200, proxies /api to :3000
```

Verification and password-reset emails land in Mailpit: <http://localhost:8025>.
To use one origin like production, build the web app and set `WEB_DIST_DIR=apps/web/dist/web/browser`; the server then serves it at `/`.

## Run it (production, Docker)

```bash
# .env: APP_URL=https://planner.example.com, JWT_ACCESS_SECRET, JWT_MEDIA_SECRET, MYSQL_PASSWORD, SMTP_*, RELEASE_TOKEN
docker compose --profile prod up -d --build
```

One image contains the API, the website and Chromium (PDF export); migrations run on start. Put it behind a
TLS-terminating reverse proxy (an nginx config is included, see below) and set `TRUST_PROXY=true`. Data (uploads, installers) lives in the `notes-data` volume.
The server's port is published on `127.0.0.1` only (`SERVER_BIND` changes that), so nothing is reachable over plain http from the network by default.
The bundled `mailpit` is a development mail catcher: configure `SMTP_*` for real email.

### Compose profiles

`docker-compose.yml` uses profiles to decide which services start. A service without a profile always starts; a service with one
starts only when you ask for that profile with `--profile <name>` (repeat the flag to combine them).

| Profile | Services | What it is for | Command |
| --- | --- | --- | --- |
| *(none)* | `mysql`, `mailpit` | **Development.** Just the database and the mail catcher; you run the server and the website yourself with `npm run start:dev` / `npm start`. | `docker compose up -d mysql mailpit` |
| `prod` | adds `server` | **Production.** Builds and runs the one image with the API, the website and PDF export, next to MySQL. It is reachable on `127.0.0.1:3000` only (see `SERVER_BIND`). Requires `APP_URL`, `JWT_ACCESS_SECRET` and `JWT_MEDIA_SECRET`. | `docker compose --profile prod up -d --build` |
| `proxy` | adds `proxy` (nginx) | **HTTPS in front of the server.** Terminates TLS on ports 80/443 and forwards to `server`. It needs the `server` service, so always combine it with `prod`; it also needs `OS_PLANNER_DOMAIN` and a certificate. | `docker compose --profile prod --profile proxy up -d --build` |
| `scale` | adds `redis` | **Several server instances.** A Redis the instances share so live events reach people connected to any of them; set `REDIS_URL=redis://redis:6379` on each. One instance needs none. | `docker compose --profile scale up -d redis` |

Notes: `mailpit` has no profile, so it also runs in production unless you stop it (`docker compose stop mailpit`) and set
real `SMTP_*` values. Use the same `--profile` flags for every later command on the stack, for example
`docker compose --profile prod --profile proxy logs -f proxy` or `... down`; without them Compose does not see the profiled services.

### HTTPS reverse proxy (nginx)

`deploy/nginx/os-planner.conf.template` redirects http to https, terminates TLS (1.2/1.3, HTTP/2), forwards the real client address,
streams large uploads (`client_max_body_size 1g`, above `MAX_VIDEO_MB` and the biggest installer), compresses text, waits up to
3 minutes for PDF export, and passes WebSocket upgrades for the live connection (`/api/realtime`, Socket.IO; `/api/collab` is reserved for co-editing).
It does not repeat the headers the server sets itself (HSTS, CSP). A request for any other host name is dropped. Share links need nothing extra: `/s/<token>` is a page of the app and `/api/links/…` an API route, both already forwarded; keep `TRUST_PROXY=true` so the wrong-password limit counts real client addresses, not the proxy's.

**With Docker** (nginx runs next to the server):

```bash
# .env
OS_PLANNER_DOMAIN=planner.example.com
APP_URL=https://planner.example.com
TRUST_PROXY=true
# certificate: put fullchain.pem and privkey.pem in ./deploy/certs (or point TLS_CERT_DIR at the folder, e.g. /etc/letsencrypt/live/planner.example.com)

docker compose --profile prod --profile proxy up -d --build
```

Certificate from Let's Encrypt (the proxy serves `/.well-known/acme-challenge/` from `ACME_DIR`, default `./deploy/acme`):

```bash
certbot certonly --webroot -w ./deploy/acme -d planner.example.com     # or: --standalone, before the proxy first starts
# TLS_CERT_DIR=/etc/letsencrypt/live/planner.example.com   (and reload nginx after renewals: docker compose exec proxy nginx -s reload)
```

A throwaway self-signed certificate for trying it out:

```bash
mkdir -p deploy/certs && openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout deploy/certs/privkey.pem \
  -out deploy/certs/fullchain.pem -subj "/CN=planner.example.com" -addext "subjectAltName=DNS:planner.example.com"
```

**With nginx on the host** (no Docker proxy): fill in the template and reload.

```bash
OS_PLANNER_DOMAIN=planner.example.com OS_PLANNER_UPSTREAM=127.0.0.1:3000 \
  envsubst '${OS_PLANNER_DOMAIN} ${OS_PLANNER_UPSTREAM}' < deploy/nginx/os-planner.conf.template | sudo tee /etc/nginx/conf.d/os-planner.conf
# then point ssl_certificate / ssl_certificate_key (and the acme-challenge root) in that file at your own paths, and: sudo nginx -t && sudo nginx -s reload
```

Behind this proxy: `APP_URL` is the https address, `TRUST_PROXY=true` (rate limits and logs then see the real client address, not the proxy's),
`CORS_ORIGINS` only if the website is on another origin. If you serve the API from its own host name, give it a second
`server` block (copy the 443 one) and set `OS_PLANNER_API_URL`/`CORS_ORIGINS` as described below.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_URL` | – | Public address; used in email links and to decide whether cookies are `Secure`. |
| `DATABASE_URL` | – | `mysql://user:pass@host:3306/db` |
| `JWT_ACCESS_SECRET`, `JWT_MEDIA_SECRET` | – | ≥ 32 random characters each. |
| `SMTP_HOST/PORT/USER/PASS/SECURE`, `MAIL_FROM` | Mailpit | Outgoing mail. |
| `DATA_DIR` | `./data` | Uploaded media and published installers. |
| `MAX_IMAGE_MB`, `MAX_VIDEO_MB`, `USER_QUOTA_MB` | 20 / 500 / 2048 | Upload limits and the storage each person gets (notes and files together). |
| `TEAM_QUOTA_MB`, `PROJECT_QUOTA_MB` | 10240 / 0 | Storage of a team (its own content plus all its projects) and of one project; `0` = a project is limited only by its team. |
| `MAX_MEMBERS_PER_TEAM`, `MAX_PROJECTS_PER_TEAM` | 100 / 50 | Team size limits. |
| `MAX_ROLES_PER_TEAM` | 100 | Roles of one team, team and project roles together (`@everyone` not counted). |
| `AUDIT_RETENTION_DAYS` | 365 | Audit-log entries older than this are removed by the nightly job. |
| `ADMIN_EMAILS` | empty | Instance administrators (comma-separated). Only an address that has been **verified** counts. They see **Administration** in the app: accounts, per-account limits, teams. Everyone else gets a 404 for `/api/admin/*`. |
| `REDIS_URL` | empty | Only for **several server instances**: they then share live events (chat, presence, permission changes) through this Redis (`redis://host:6379`). Empty = one instance, events stay in memory. `docker compose --profile scale up -d redis` starts one for development. `GET /api/health` reports `realtime: "degraded"` while the configured Redis cannot be reached. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | empty | **Web Push.** Make a pair with `npx web-push generate-vapid-keys` and give a contact address (`mailto:you@example.com`). Without all three, push is off and **Settings → Notifications** hides it. The server only sends to the push services of the big browsers (Google, Mozilla, Apple, Microsoft); `PUSH_EXTRA_ENDPOINTS` adds origins. |
| `NOTIFY_AWAY_SECONDS`, `NOTIFY_EMAIL_INTERVAL_MINUTES`, `NOTIFY_PUSH_COALESCE_SECONDS`, `NOTIFY_SWEEP_SECONDS` | 600 / 15 / 10 / 30 | Notification timing: how long without activity counts as "away" (for email "only when I am away"), the least time between two emails about one chat and between two pushes about one channel, and how often waiting emails are looked at (`0` = send none). |
| `RELEASE_TOKEN` | empty | Enables the release-publishing endpoints. Empty = they do not exist. |
| `CHROME_PATH` | auto-detected | Browser used for PDF export. Without one the web app prints locally instead. |
| `TRUST_PROXY` | false | Set behind a reverse proxy. |
| `CORS_ORIGINS` | empty | Websites on other origins that may call this API (comma-separated origins; `APP_URL` is always allowed). |
| `COOKIE_SAMESITE` | `strict` | `strict`, `lax` or `none` for the refresh cookie. `none` needs an https `APP_URL`. |
| `OS_PLANNER_API_URL` | – | Address of the API as browsers see it, if it is not the website's origin (adds it to the CSP). Defaults to the `apiUrl` in the built site's `config.json`. |
| `WEB_DIST_DIR` | – | Directory of the built website to serve at `/`. |

## Pointing the website and apps at an API

By default the website calls `/api` on its own origin, which is what the Docker image gives you. If your API lives
somewhere else (say the site on `planner.example.com` and the API on `api.example.com`), tell the build:

| Build | Setting | What happens if it is not set |
| --- | --- | --- |
| Website (`npm run build -w @os-planner/web`) | `OS_PLANNER_API_URL` | You are **asked** on an interactive terminal (blank = same origin). In CI, with `CI=1` or `OS_PLANNER_NO_PROMPT=1`, or without a terminal it is not asked and the API is taken to be on the same origin. |
| Desktop app (`npm run build -w @os-planner/desktop`) | `OS_PLANNER_SERVER_URL` (the website the window opens; the site's `config.json` then says where the API is) | You are asked (default `http://localhost:3000`). |
| Docker image | `--build-arg OS_PLANNER_API_URL=…` (or `OS_PLANNER_API_URL` in `.env` for compose) | Same origin. |

The value is read from the environment, then the repo `.env`, then asked. It is written to `config.json` next to
`index.html` (`{ "apiUrl": "https://api.example.com" }`). **You can edit that file in a deployed build to repoint the site
without rebuilding.** Installed copies pick the change up on their next start (the last value is remembered for offline use).
`npm start` never asks; it uses the dev proxy (`OS_PLANNER_DEV_API_TARGET`, default `http://localhost:3000`).

On the API side, allow the website:

```bash
CORS_ORIGINS=https://planner.example.com      # exact origins, never "*"; the refresh cookie is sent with credentials
COOKIE_SAMESITE=strict                       # fine when site and API share a registrable domain (planner.example.com + api.example.com)
# COOKIE_SAMESITE=none                       # only for unrelated domains; requires an https APP_URL
```

The live connection (`/api/realtime`, Socket.IO) goes to the API's origin as well. If the website is served by a static host with its own
Content-Security-Policy, `connect-src` must list the API's `ws://`/`wss://` address next to its `http(s)://` one (the `http:` form does not cover WebSockets).

Same-site subdomains (`strict`) are the setup to prefer: browsers are phasing out cross-site cookies, so `none` may stop working.
Images and videos from `/api/media` may be embedded by the websites named in `APP_URL` and `CORS_ORIGINS` (judged by the `Origin`/`Referer` the browser sends, which by default is the site's origin); nothing else is made embeddable.

## Desktop apps and the download page

```bash
npm run dist:win   -w @os-planner/desktop      # Windows: NSIS installer + portable .exe
npm run dist:linux -w @os-planner/desktop      # Linux AppImage/deb/rpm, built in Docker
OS_PLANNER_API_URL=https://planner.example.com RELEASE_TOKEN=... node scripts/publish-desktop.mjs   # the API address (same as the site if they share an origin)
```

Publishing uploads the files to the server; the website's **/download** page then lists them (with server-computed
SHA-256 checksums) next to the **Install as an app** (PWA) button, and installed apps update from `/downloads/`.
`OS_PLANNER_SERVER_URL` (asked for when not set) is baked into a build as the app's default website; people can change it from *File › Change server…*. Updates come from the `/downloads/` of the API named in the website's `config.json`.
On a Linux machine or in CI the Linux packages build with plain `electron-builder --linux`.

## Themes

Settings → Appearance offers **Same as device** (light or dark, following the operating system live), **Light**, **Dark**
and the coloured **Purple**, **Red**, **Green**, **Blue** and **Dark blue**. The choice belongs to the account: it follows
the person to every device and is restored at sign-in; a choice made offline applies at once and is sent when the
connection returns. The coloured themes are dark and understated (tinted surfaces, a soft accent). PDF and Markdown exports
are always light, whatever theme is on screen.

| Light | Dark | Purple | Red |
| --- | --- | --- | --- |
| ![Light](docs/themes/light.png) | ![Dark](docs/themes/dark.png) | ![Purple](docs/themes/purple.png) | ![Red](docs/themes/red.png) |

| Green | Blue | Dark blue |
| --- | --- | --- |
| ![Green](docs/themes/green.png) | ![Blue](docs/themes/blue.png) | ![Dark blue](docs/themes/darkblue.png) |

To add or change a theme: edit `apps/web/src/themes.scss`, add its id to `THEMES` (`packages/shared/src/dto/common.ts`),
`public/theme-boot.js` and `DARK_THEMES` (`core/theme.ts`) if it is dark, add its `theme.<id>` strings, then run
`npm run check:themes`, which fails if any theme's text, accent or borders are hard to read or the lists disagree.

## Administration, storage limits, teams and projects

**Administration.** Accounts whose verified email is listed in `ADMIN_EMAILS` get *Administration* in the sidebar: instance
statistics, the list of accounts with their storage, per-account limit overrides and the **Teams** section (create a team,
name its owner by email, delete it). Everybody else who types `/app/admin` gets the same "not found" page as for any unknown
address; nothing tells them the area exists. If the owner named for a new team has no verified account yet, the team waits
for them and is handed over when they first sign in with that verified email.

**Storage limits.** Every account, team and project has a limit (`USER_QUOTA_MB`, `TEAM_QUOTA_MB`, `PROJECT_QUOTA_MB`, plus the
largest single file); an administrator can override each of them. A team's figure includes its projects. Going over answers
`413 { code: "quota_exceeded", scope, limit, used, requested }`; the app shows a banner, keeps the file waiting on the
device, and keeps saving text so nothing is lost. Settings → Storage shows the usage by kind.

**Spaces, teams and projects.** Notes, media and the sync sequence belong to a *space*: each account has a personal one, each
team has one, and every project and sub-project (at most 16 levels deep, `MAX_PROJECTS_PER_TEAM` per team) has its own. The strip on the left (the *rail*) switches between *My notes* and each team; inside a team the sidebar
shows the project tree (drag a project onto another to move it, or use its menu: rename, move, archive, delete) and the header
shows the breadcrumb `Team / Project / Sub-project`. Everything opens offline from the device's database; a team the person
loses (removed, deleted) disappears from the device on the next sync.

What a person may do is decided by one permission engine (`packages/shared/src/permissions`, a bit field) that runs on the
server and, for hiding buttons, in the web app. The rules: the owner and administrators-by-role can do everything; the
permissions of `@everyone` and of the person's roles are combined, then channel-style overwrites apply from broad to narrow
(everyone, roles, the person). A team or project you cannot see answers **404**, one you can see but may not change **403**.
A project is visible to its members and to anyone who can manage projects; members of a sub-project must belong to its parent.
Deleting a team or project removes it at once; its content is purged for good after the 30-day trash period.

**Roles, overwrites and the audit log.** Team settings (the gear next to the team name) has these tabs (the ones for joining people, described below, are *Invitations*, *Requests*, *Bans* and *Discoverability*, each shown only to people who may use it):

- **Members**: who is in the team with their role chips; add or remove a role with one click, set a nickname.
- **Roles**: create roles with a colour, "show separately" and "allow @mention", pick their permissions from a searchable grid grouped like
  Discord's, and drag them to reorder (most powerful first; `@everyone` is always last and can only change its permissions).
- **View as**: pick a role or a member and see every permission with the rule that decided it ("Denied for @everyone on Apollo",
  "Granted by Dev"). It runs the server's own engine, so it explains why a control is disabled for someone.
- **Audit log**: who changed what and when, filterable by action, person and date, each entry expandable to a before/after view.
  Entries are written in the same transaction as the change, are append-only, and are removed after `AUDIT_RETENTION_DAYS`.
  Reading it needs the *View audit log* permission.

A project's **Permissions** page (a button on the project) sets overwrites for `@everyone`, each role and each member with a
tri-state control: ✓ allow, – inherit, ✗ deny. Overwrites apply to the project and everything below it, a deeper level beats a
shallower one, and a person's own allow beats a role's deny on the same level. A subject with nothing set is "synced with the
parent"; *Reset to inherited* removes the overwrite. The page also manages **project roles**, which exist only in that project and
its sub-projects, and has its own *View as*. A member whose overwrites remove every *View* permission no longer sees the project
(404); people who may manage projects still do, so an overwrite can always be repaired.

The rules the server enforces: you need *Manage roles* for anything about roles (the owner and administrators bypass that); you can
only create, edit, delete, give or take roles **strictly below your own highest role**, and only permissions you hold yourself;
`@everyone` cannot be deleted, renamed or moved and only the owner may give it *Administrator*; overwrites can only allow or deny
what you hold; deleting a role takes it off its members and out of every overwrite in one transaction; deleting a project deletes
its roles and overwrites. The last administrator cannot leave or lose the role (this matters once an owner's account is gone), and
the owner cannot be removed. Every refusal answers 403 with the reason (for example `role_at_or_above`) and writes no audit entry.

**Joining teams.** Teams are made by an administrator, but people get in on their own:

- **Invitations** (team settings → *Invitations*, needs *Create invites*). An **email invitation** goes to one address, is good for
  that address only and for 14 days. The mail links to `/invite/<token>`; somebody with no account registers from there with the
  invited address, and joins the moment they verify it. A **link** can be used by anybody who has it, up to a number of people
  you choose, for 7 days by default (1 to 90). An invitation can carry roles (you can only attach roles you could assign by hand)
  and a top-level project to join. Only a hash of the token is stored, so a link is shown once, when it is created. Unknown,
  expired, withdrawn and used-up tokens all answer the same `404 invalid_invite`, and the preview a visitor gets shows the team's
  name, icon and size, never its members. Withdrawing an invitation works at once; an invitation made by someone who has since
  left the team stops working.
- **Public directory** (the compass at the bottom of the rail, `/app/directory`). A team with *Discoverability* switched on is
  listed with its name, one-line blurb and up to eight tags, and either lets anybody **join** or lets them **ask**; the people who
  *Manage members* see a badge on the team in the rail and a *Requests* tab to approve or deny, and the person is told by mail.
  Private teams never appear, not even when their exact name is searched.
- **Leaving, removing, banning.** Anybody can leave; the owner must first **transfer ownership** (type the team name and your
  password; the previous owner keeps their roles but loses the owner's bypass). Removing or banning someone needs *Manage members*
  and a rank above theirs. A **ban** removes the person and keeps them out by every way in (invitation, link, directory, request)
  until it is lifted; the person is not told who banned them. A person who is removed or leaves loses the team from their device on
  the next sync.
- Joining always needs a verified email address, respects the team's member limit (`413 quota_exceeded`, scope `team`; joins are
  serialised per team, so the limit holds under load), and is written to the audit log (`invite.*`, `member.*`, `request.*`).
- No new settings: the limit is `MAX_MEMBERS_PER_TEAM` (or the admin's override), mail uses the existing `SMTP_*` and `APP_URL`.

`GET /api/sync/changes?cursors={"<spaceId>":<seq>}` returns what changed per space plus `revokedSpaces` (spaces to forget);
the older `?since=` form still works and means the personal space.

## Live updates, presence and chat

**One live connection.** Once you are signed in the page opens a Socket.IO connection to `/api/realtime` (websocket, with long polling as a fallback
for strict proxies), authenticated with the access token, which it renews while the page is open. A connection is only ever in rooms the server
decided it may be in: `room:join` asks the same permission code as the REST API, and a room that is refused looks exactly like one that does not
exist. When roles, overwrites or membership change (the same audit entries the team's log shows), people concerned are told to refresh and any room
they may no longer be in is taken away **before the request that changed it answers**. Signing out, changing the password or ending a session in
Settings closes that login's connections. Per person: 5 connections, 100 rooms per connection, 1 MB per message, floods dropped (counts for
administrators at `GET /api/admin/realtime`; `GET /api/health` also says `realtime: "ok"` or `"degraded"`).

**What it drives.** A change in a space makes the other devices sync at once instead of waiting for the 60 s timer; a role change shows up in the
other person's open app; member lists show who is online or idle (nothing is stored: it follows live connections, announced to the teams you share,
at most every 5 s; **Settings → Privacy → Appear offline** hides you). The top bar shows the connection (live, reconnecting, none). After a lost
connection the app asks each feature for what it missed (nothing is replayed by the socket itself).

**Several server instances.** One instance needs nothing. To run more, point every instance at one Redis with `REDIS_URL` (`docker compose --profile
scale up -d redis` starts one for development); events then reach people connected to any instance. Behind a proxy, WebSocket clients need no stickiness;
clients that fall back to long polling do (`ip_hash` in the nginx upstream, or one instance).

**Chat.** Text channels (and categories that group them) live in a team or in a project, listed in the sidebar under their team or project. Messages are
Markdown (bold, italic, strike, code and fenced code, quotes, lists, links; no HTML ever), with edit/delete, reactions, replies, pins, threads, files
(pictures show inline with a lightbox; the type is checked by its bytes), unread counts, "jump to first unread", search inside a channel (accents and
case ignored), slowmode, archiving and per-channel permissions. Who may do what follows the team's roles and the project's overwrites, with a category's
and the channel's own overwrites on top (**Channel settings → Who can see and use it**); a channel someone cannot see answers 404 everywhere.
Messages and files count toward the team's or project's storage (text as documents). Offline you can still read the last 200 messages of each
channel you opened, and what you write is queued and sent in order when the connection is back (each message is sent under its own id, so a retry never
duplicates it). Without `READ_MESSAGE_HISTORY` a person only sees what was said after they first opened the channel.

**Direct messages.** A private conversation between two people who share a team (**Direct messages** in the rail, or **Message** on a member).
It is the same chat as in a channel (Markdown, files, reactions, replies, pins, edit and delete, unread, offline reading and queued sending), but nobody
else can read it: moderators, owners and instance administrators get a 404 like everybody else, and nothing about it is in a team's audit log.
Whether you may write to somebody is decided again on **every message**: both accounts must exist, neither may have blocked the other, the person must
accept messages (**Settings → Privacy → Who can message me**) and at least one team you share must allow them (**Team settings → Discover → Allow
direct messages between members**). Every refusal looks the same (`403 dm_not_allowed`), so nobody can tell whether they were blocked. History stays
readable after the last shared team is gone or somebody is blocked (blocks are listed and removed in Settings → Privacy). Files and text in a
conversation count toward the **sender's** storage, never a team's. Closing a conversation only hides it in your list until something new arrives.

**Mentions, notifications and mute.** Type `@` in a channel for people, roles (the ones set as mentionable, or any with *Mention everyone*), `@everyone`
and `@here` (only with *Mention everyone*). The text stores ids, so a mention follows a rename; the server decides which mentions count (the person must
exist and be able to see the channel) and the author is warned about those that did not. The **bell** shows the inbox (all or only mentions, grouped by
day) and the channels and teams in the sidebar show how many mentions are waiting. Every team, project, channel and conversation has its own bell button
**Notification settings**: everything / only mentions / nothing / use the setting above, switches for `@everyone`/`@here` and for roles (and for mentions by name),
a mute for 15 minutes to "until I turn it back on" (a direct mention still gets through a mute unless you turn that off too), email (off / mentions / everything,
"only when I'm away") and push, and a line saying what is in effect and where it comes from. **Settings → Notifications** holds your defaults, quiet hours (push
and email only) and this device's Web Push. Email is its own option per chat: at most one mail per chat every 15 minutes with the count and the latest messages,
never attachments, in your language, with one-click links to mute the chat or stop the mails (they work without signing in and for that chat only). A channel can
hide message text from push and email (**Channel settings → Hide message text in push and email**; age-restricted channels always do). Notifications are removed after 90 days.

## Shared notebooks and share links

**Team and project notebooks.** Every team and project has notebooks of its own, listed in the sidebar under **Notebooks** (the project's below the team's
while you are in a project). Who may do what is decided by the permissions *View notebooks*, *Create notebooks*, *Edit pages*, *Delete pages*, *Manage notebooks*
and *Share notebooks*; a person who may only view gets a read-only editor and a banner saying so, and the controls they cannot use are not shown. One notebook
can have its own **Who can see this…** (allow/deny per role or member, on top of the project's): a notebook someone may not view answers 404 everywhere (list,
search, export, sync, files) and disappears from their device at the next sync. The controls are chosen from what the server last said the person may do
(`GET /api/notebook-permissions`, kept locally, so they are right offline); the server decides again on every request.

**Sharing a personal notebook.** **Share…** in a notebook's menu has two tabs. *People*: a teammate by name, or any email address, with *can read* or *can edit*.
For an address the answer is the same whether or not it has an account (an address without a verified account waits, and the share starts when somebody
verifies it). The notebook then shows up for them under **Shared with me**, live; changing the access or removing them takes effect in their open editor
at once. Whatever an editor writes (text and files) counts toward the **owner's** storage. Nobody who was given access can pass it on, rename or delete the
notebook. A recipient can give a notebook back from its menu.
*Link*: an address like `https://your-site/s/<token>`. A **read** link opens in any browser with no account (no app shell, no sign-in, no cookies; tree, search
inside the notebook, pictures, print), an **edit** link asks the visitor to sign in and then adds the notebook to their *Shared with me* as an edit share that
ends when the link is revoked, even in the middle of their session. A link can expire and can have a password (argon2id; five wrong tries per link and address
close it for 15 minutes; the password is traded for a two-hour session bound to that link). The server stores only a hash of the token, so the address can
be copied only while the dialog that made it is open; revoking is always possible. A link opens that notebook only: never another one, the owner's other
data, a trashed page, or files its pages do not use. Expired, revoked, unknown and "its notebook is gone" all answer the same 404 (*This link does not work*).
Public pages are sent with `X-Robots-Tag: noindex` and `Referrer-Policy: no-referrer`, and show the owner's name only if the link was made with *Show my
name*. A team's notebooks can only get **read** links, and only while the team's *Allow public links to notebooks* (Team settings → Discover) is on.

**Moving.** **Move to another space…** moves a notebook (with its pages and files) between your own space, a team and a project you may create notebooks in. The
storage it uses moves with it in one step, or the whole move is refused (`413`) when the target has no room. Its shares, links and overwrites do **not** follow:
they end. A file used by this notebook and by another one blocks the move (copy it first). Other people's devices drop the notebook from the space it left.

**Trash and export** work in team and shared notebooks with the same permissions (restoring needs *Delete pages*, or *Manage notebooks* for a notebook).

## Tests

```bash
npm run build                    # shared, web, server
npm test                         # unit + integration: build scripts (23), shared (295), server (454, needs MySQL; Redis for the two-instance test)
npm run e2e                      # the real website in real Chrome (62 scenarios, 5 of them with the API on another origin, 8 for themes, 2 for storage limits, 2 for teams, 2 for roles, 4 for joining teams, 3 for the live connection, 4 for chat, 3 for direct messages, 4 for mentions, mute, email and Web Push, 6 for shared notebooks, links and moving; needs MySQL + Mailpit)
npm test -w @os-planner/desktop       # the Electron shell, packaged app, publish + download (needs a Windows build)
node scripts/i18n-check.mjs      # every translation key exists in English and Portuguese
npm run check:themes             # contrast of every colour theme (also part of `npm test`)
```

The server tests run against a real MySQL database (`notes_test`), the browser tests against a throwaway one (`notes_e2e`).

## How the important parts work

- **Sync.** Every change is applied to the local IndexedDB database first and queued. A per-user, strictly increasing
  `changeSeq` (taken under a row lock, so seq order equals commit order) lets clients ask for "everything after N" and never
  miss a row. Page content is saved with a version check; if the page changed elsewhere the server answers `409` with its
  copy and the client keeps *both*: the server version becomes the page and the local text becomes a "conflict copy".
- **Offline.** The service worker caches the app; Dexie holds notes and media. Unsynced edits survive closing the tab (a
  synchronous draft is written as the page unloads). Signing out wipes the device copy and warns if changes are unsynced; an
  expired session only closes it.
- **Security.** Argon2id passwords; 15-minute access tokens in memory; rotating httpOnly refresh cookies with reuse detection;
  strict CSP (no inline scripts, no `eval`); uploads are sniffed by magic bytes, SVG refused, JPEG EXIF stripped; every query
  is scoped to the user and answers 404, never 403; the PDF renderer blocks every network request except the document, its
  own assets and the user's own media.
- **Plots** use a small parser (no `eval`) and are drawn as SVG, so they work under the CSP and look the same in the editor and in a PDF.

## Known limitations

- Chat lists are not virtualised: the open channel keeps what it loaded (older messages come in pages as you scroll up). A very long session in a very busy channel grows the page; windowing is the planned fix.
- Chat has no mentions, notifications or direct messages yet (phases 8 and 9); attachments are pictures and videos (the media allowlist), shown as chips when not an image.
- The first page load is ~460 kB gzipped: `@os-planner/shared` is a single bundle that pulls zod and the TipTap schema into the
  entry chunk. Splitting a light entry point out of it would roughly halve that.
- The Windows installer is **not code-signed**, so SmartScreen warns on first run (the download page says so). The Linux
  `.deb`/`.rpm` do not self-update; AppImage and the Windows installer do.
- Categories can be moved within their notebook (not between notebooks); reordering uses Move up/down, not drag and drop.
- Mermaid, Chart.js and KaTeX load as one ~5.8 MB script (`/print/planner-libs.js`) on first use of a diagram or chart.
- OAuth sign-in, two-factor authentication, real-time co-editing and page history are not implemented. Until co-editing arrives, two people editing the same page keep the older rule: the second save is refused and kept as a conflict copy.
- A notebook that was shared (or made public) has no per-page sharing, comments or suggestion mode; the public view is not indexed by search engines on purpose.
