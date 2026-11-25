# Notes

A self-hosted note-taking website with notebooks, categories and pages, a rich editor (math, diagrams, charts,
function plots, code, images, video), PDF export, offline editing with sync, and accounts. It runs in the
browser, installs as a PWA, and is downloadable as a desktop app for Windows and Linux, **all from the website**.

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
npm run build -w @notes/shared
npm run prisma:migrate -w @notes/server

npm run start:dev -w @notes/server      # API on :3000
npm run start -w @notes/web             # website on :4200, proxies /api to :3000
```

Verification and password-reset emails land in Mailpit: <http://localhost:8025>.
To use one origin like production, build the web app and set `WEB_DIST_DIR=apps/web/dist/web/browser`; the server then serves it at `/`.

## Run it (production, Docker)

```bash
# .env: APP_URL=https://notes.example.com, JWT_ACCESS_SECRET, JWT_MEDIA_SECRET, MYSQL_PASSWORD, SMTP_*, RELEASE_TOKEN
docker compose --profile prod up -d --build
```

One image contains the API, the website and Chromium (PDF export); migrations run on start. Put it behind a
TLS-terminating reverse proxy and set `TRUST_PROXY=true`. Data (uploads, installers) lives in the `notes-data` volume.
The bundled `mailpit` is a development mail catcher: configure `SMTP_*` for real email.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_URL` | – | Public address; used in email links and to decide whether cookies are `Secure`. |
| `DATABASE_URL` | – | `mysql://user:pass@host:3306/db` |
| `JWT_ACCESS_SECRET`, `JWT_MEDIA_SECRET` | – | ≥ 32 random characters each. |
| `SMTP_HOST/PORT/USER/PASS/SECURE`, `MAIL_FROM` | Mailpit | Outgoing mail. |
| `DATA_DIR` | `./data` | Uploaded media and published installers. |
| `MAX_IMAGE_MB`, `MAX_VIDEO_MB`, `USER_QUOTA_MB` | 20 / 500 / 2048 | Upload limits. |
| `RELEASE_TOKEN` | empty | Enables the release-publishing endpoints. Empty = they do not exist. |
| `CHROME_PATH` | auto-detected | Browser used for PDF export. Without one the web app prints locally instead. |
| `TRUST_PROXY` | false | Set behind a reverse proxy. |
| `CORS_ORIGINS` | empty | Websites on other origins that may call this API (comma-separated origins; `APP_URL` is always allowed). |
| `COOKIE_SAMESITE` | `strict` | `strict`, `lax` or `none` for the refresh cookie. `none` needs an https `APP_URL`. |
| `NOTES_API_URL` | – | Address of the API as browsers see it, if it is not the website's origin (adds it to the CSP). Defaults to the `apiUrl` in the built site's `config.json`. |
| `WEB_DIST_DIR` | – | Directory of the built website to serve at `/`. |

## Pointing the website and apps at an API

By default the website calls `/api` on its own origin, which is what the Docker image gives you. If your API lives
somewhere else (say the site on `notes.example.com` and the API on `api.example.com`), tell the build:

| Build | Setting | What happens if it is not set |
| --- | --- | --- |
| Website (`npm run build -w @notes/web`) | `NOTES_API_URL` | You are **asked** on an interactive terminal (blank = same origin). In CI, with `CI=1` or `NOTES_NO_PROMPT=1`, or without a terminal it is not asked and the API is taken to be on the same origin. |
| Desktop app (`npm run build -w @notes/desktop`) | `NOTES_SERVER_URL` (the website the window opens; the site's `config.json` then says where the API is) | You are asked (default `http://localhost:3000`). |
| Docker image | `--build-arg NOTES_API_URL=…` (or `NOTES_API_URL` in `.env` for compose) | Same origin. |

The value is read from the environment, then the repo `.env`, then asked. It is written to `config.json` next to
`index.html` (`{ "apiUrl": "https://api.example.com" }`). **You can edit that file in a deployed build to repoint the site
without rebuilding.** Installed copies pick the change up on their next start (the last value is remembered for offline use).
`npm start` never asks; it uses the dev proxy (`NOTES_DEV_API_TARGET`, default `http://localhost:3000`).

On the API side, allow the website:

```bash
CORS_ORIGINS=https://notes.example.com      # exact origins, never "*"; the refresh cookie is sent with credentials
COOKIE_SAMESITE=strict                       # fine when site and API share a registrable domain (notes.example.com + api.example.com)
# COOKIE_SAMESITE=none                       # only for unrelated domains; requires an https APP_URL
```

Same-site subdomains (`strict`) are the setup to prefer: browsers are phasing out cross-site cookies, so `none` may stop working.
Images and videos from `/api/media` may be embedded by the websites named in `APP_URL` and `CORS_ORIGINS` (judged by the `Origin`/`Referer` the browser sends, which by default is the site's origin); nothing else is made embeddable.

## Desktop apps and the download page

```bash
npm run dist:win   -w @notes/desktop      # Windows: NSIS installer + portable .exe
npm run dist:linux -w @notes/desktop      # Linux AppImage/deb/rpm, built in Docker
NOTES_API_URL=https://notes.example.com RELEASE_TOKEN=... node scripts/publish-desktop.mjs   # the API address (same as the site if they share an origin)
```

Publishing uploads the files to the server; the website's **/download** page then lists them (with server-computed
SHA-256 checksums) next to the **Install as an app** (PWA) button, and installed apps update from `/downloads/`.
`NOTES_SERVER_URL` (asked for when not set) is baked into a build as the app's default website; people can change it from *File › Change server…*. Updates come from the `/downloads/` of the API named in the website's `config.json`.
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

## Tests

```bash
npm run build                    # shared, web, server
npm test                         # unit + integration: build scripts (23), shared (71), server (179, needs MySQL)
npm run e2e                      # the real website in real Chrome (32 scenarios, 5 of them with the API on another origin, 8 for themes; needs MySQL + Mailpit)
npm test -w @notes/desktop       # the Electron shell, packaged app, publish + download (needs a Windows build)
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

- The first page load is ~460 kB gzipped: `@notes/shared` is a single bundle that pulls zod and the TipTap schema into the
  entry chunk. Splitting a light entry point out of it would roughly halve that.
- The Windows installer is **not code-signed**, so SmartScreen warns on first run (the download page says so). The Linux
  `.deb`/`.rpm` do not self-update; AppImage and the Windows installer do.
- Categories can be moved within their notebook (not between notebooks); reordering uses Move up/down, not drag and drop.
- Mermaid, Chart.js and KaTeX load as one ~5.8 MB script (`/print/notes-libs.js`) on first use of a diagram or chart.
- OAuth sign-in, two-factor authentication, sharing/collaboration and page history are not implemented.
