# OS_Planner

OS_Planner is an open source, self-hosted planner: a website with notebooks, categories and pages, a rich editor (math,
diagrams, charts, function plots, code, images, video), PDF export, offline editing with sync, accounts, and teams with
projects. It runs in the browser, installs as a PWA, and is downloadable as a desktop app for Windows and Linux, **all from the website**.

```
notebook ─ category ─ nested category ─ page        every level has its own name; reorder, move, trash, restore
```

## What is in the box

| Part | What it is |
| --- | --- |
| `apps/server` | NestJS 12 + Prisma 7 + **MySQL 8.4**. Auth, notebooks/categories/pages, sync, media, search, PDF/Markdown export, release downloads. Also serves the website. |
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

Notes: `mailpit` has no profile, so it also runs in production unless you stop it (`docker compose stop mailpit`) and set
real `SMTP_*` values. Use the same `--profile` flags for every later command on the stack, for example
`docker compose --profile prod --profile proxy logs -f proxy` or `... down`; without them Compose does not see the profiled services.

### HTTPS reverse proxy (nginx)

`deploy/nginx/os-planner.conf.template` redirects http to https, terminates TLS (1.2/1.3, HTTP/2), forwards the real client address,
streams large uploads (`client_max_body_size 1g`, above `MAX_VIDEO_MB` and the biggest installer), compresses text, waits up to
3 minutes for PDF export, and already passes WebSocket upgrades for the real-time paths planned for later (`/api/realtime`, `/api/collab`).
It does not repeat the headers the server sets itself (HSTS, CSP). A request for any other host name is dropped.

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

**Roles, overwrites and the audit log.** Team settings (the gear next to the team name) has four tabs:

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

`GET /api/sync/changes?cursors={"<spaceId>":<seq>}` returns what changed per space plus `revokedSpaces` (spaces to forget);
the older `?since=` form still works and means the personal space.

## Tests

```bash
npm run build                    # shared, web, server
npm test                         # unit + integration: build scripts (23), shared (90), server (242, needs MySQL)
npm run e2e                      # the real website in real Chrome (36 scenarios, 5 of them with the API on another origin, 8 for themes, 2 for storage limits, 2 for teams; needs MySQL + Mailpit)
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

- The first page load is ~460 kB gzipped: `@os-planner/shared` is a single bundle that pulls zod and the TipTap schema into the
  entry chunk. Splitting a light entry point out of it would roughly halve that.
- The Windows installer is **not code-signed**, so SmartScreen warns on first run (the download page says so). The Linux
  `.deb`/`.rpm` do not self-update; AppImage and the Windows installer do.
- Categories can be moved within their notebook (not between notebooks); reordering uses Move up/down, not drag and drop.
- Mermaid, Chart.js and KaTeX load as one ~5.8 MB script (`/print/planner-libs.js`) on first use of a diagram or chart.
- OAuth sign-in, two-factor authentication, sharing/collaboration and page history are not implemented.
