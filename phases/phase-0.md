# Phase 0: Configurable API URL (done)

**Status:** implemented and tested. Kept here as the reference for how every later phase must treat API addresses.

## Goal
Notes is open source, so whoever builds the website or the apps must be able to say where the API lives, and must be asked when they have not said. The website no longer assumes the API is on its own origin.

**Depends on:** nothing. **Needed by:** every phase that adds a client-side URL (sockets in 6, share links in 10, collab in 11, feeds in 14).

## In scope
- One build setting, `NOTES_API_URL`, for the website; `NOTES_SERVER_URL` (the website the window opens) for the desktop app.
- Resolution order: process env → repo `.env` → interactive question (only on a terminal and not in CI) → default. Blank answer = same origin. An explicitly empty variable counts as an answer and skips the question.
- A runtime `config.json` next to `index.html` (`{"apiUrl": ""}`) read before the app starts; editable after deployment.
- Server support for a separate origin: CORS allowlist with credentials, configurable cookie SameSite, media embeddable by trusted sites, CSP that names the API origin.
- Docker build argument and compose pass-through.

## Out of scope
Several APIs at once, per-user API selection, API discovery.

## Design
- `scripts/lib/resolve-setting.mjs`: `resolveSetting`, `normaliseUrl`, `urlOrEmpty`, `readDotEnv`, `canPrompt`. Reads buffered input through the readline async iterator so piped answers are not lost.
- `scripts/configure-web.mjs` writes `apps/web/public/config.json` (git-ignored). `apps/web/config.example.json` documents the shape. `npm start` and `watch` use `--no-prompt`.
- Web: `core/api-config.ts` (`loadApiConfig`, `apiBase`, `apiUrl`), `core/api-base.interceptor.ts` (prefixes `/api/` and sets `withCredentials` on `/api/auth/*`; registered *after* `authInterceptor`, which recognises API calls by the `/api/` prefix). `main.ts` loads the config before bootstrapping. Fallback chain: `config.json` → last value seen on this device (`localStorage`) → same origin.
- Anything the browser fetches by itself (img/video `src`, download links) goes through `apiUrl()` (`data/media-store.ts`, `features/site/apps-panel.ts`).
- Server: `CORS_ORIGINS` (exact origins; `*` is rejected), `COOKIE_SAMESITE` (`none` requires an https `APP_URL`), `NOTES_API_URL` (else read from the served build's `config.json`) added to CSP `connect-src`/`img-src`/`media-src`. `/api/media/*` gets `Cross-Origin-Resource-Policy: cross-origin` only when the request's `Origin`/`Referer` is `APP_URL` or in `CORS_ORIGINS`. `config.json` is never cached.
- Desktop: `scripts/prepare.mjs` asks for `NOTES_SERVER_URL`; the update feed is `${apiUrl || website}/downloads/` discovered from the website's `config.json`. `scripts/publish-desktop.mjs` uploads to `NOTES_API_URL || NOTES_SERVER_URL`.
- Repo hygiene found on the way: `.gitignore` and `.prettierignore` had `data/`, which also hid `apps/web/src/app/data/` (the offline layer). Anchored to `/data/`.

## Data model, API, i18n, quota
No database changes, no new endpoints and no new UI strings. No stored bytes, so no quota impact. Security notes: `CORS_ORIGINS` never accepts `*`; `SameSite=None` requires https; the media embedding rule trusts only `APP_URL` and `CORS_ORIGINS`.

## Implementation steps (done)
1. `scripts/lib/resolve-setting.mjs` + tests; `scripts/configure-web.mjs`; web `package.json` scripts; dev proxy as `proxy.conf.mjs`.
2. Web runtime: `api-config.ts`, `api-base.interceptor.ts`, `main.ts`, `media-store.ts`, `apps-panel.ts`.
3. Server: `env.ts` (settings and validation), `app.setup.ts` (CORS, CSP, media embedding, no-cache for `config.json`), `auth.controller.ts` (cookie options).
4. Desktop: `prepare.mjs`, update-feed discovery in `main.ts`, `publish-desktop.mjs`.
5. Docker, compose, `.env.example`, README, `.gitignore`/`.prettierignore` fix.
6. Tests: server `cors.test.ts`, e2e `cross-origin.e2e.mjs` with `startSite()` and `startStack({serveWeb:false})` in the harness.

## Rules for later phases
1. Client code writes plain `/api/...` paths with `HttpClient`; URLs handed to the browser use `apiUrl()`.
2. Sockets and Hocuspocus connect to `apiBase() || location.origin`; the server allows the same origins as CORS.
3. Links shown to people (invites, share links, feed URLs) are built from `APP_URL`, never from the API origin.
4. Any new cookie is set with the options from `COOKIE_SAMESITE`.

## Acceptance criteria (all met)
1. [unit] Setting precedence is env > `.env` > prompt > default; no question without a terminal, in CI, with `NOTES_NO_PROMPT`, or with `prompt:false`; invalid answers are re-asked (three tries); invalid env values fail with a readable message. (`scripts/lib/resolve-setting.test.mjs`, 13 tests)
2. [server] Preflight from an allowed origin returns credentials + the headers the app sends; other origins get no `Access-Control-Allow-Origin`; never `*`. (`apps/server/test/cors.test.ts`)
3. [server] The refresh cookie follows `COOKIE_SAMESITE`; `none` on http fails at startup; clearing it uses the same attributes.
4. [server] Media is embeddable only by trusted origins; JSON endpoints never.
5. [server] The CSP of a served build includes the API origin from `config.json`; none when the API shares the origin; `config.json` answers `no-cache`.
6. [web e2e] With the site on `:4300` and the API alone on `:3101`: sign up, verify through the mailed link, reload and stay signed in; every API call goes to the API origin. (`apps/web/e2e/cross-origin.e2e.mjs`)
7. [web e2e] An uploaded image appears on a second device and an `<img>` on the site loads it straight from the API origin.
8. [web e2e] The download page lists builds from the API and the file downloads intact from the API origin.
9. [web e2e] A stranger origin is blocked; editing `config.json` repoints the site without a rebuild.
10. [desktop] `prepare.mjs` honours `NOTES_SERVER_URL`, rejects `ftp://…`, defaults to `http://localhost:3000`; the existing desktop suite passes (7).

## Result
Scripts 13 · shared 70 · server 178 (+14) · web e2e 24 of 24 (after the fix below) · cross-origin e2e 5 (new, inside the 24) · desktop 7.

**Open item (fixed, 2026-11-25):** the existing web e2e `headings, lists, code, tables, math, diagrams, charts and plots are saved and come back` failed deterministically after an equation was inserted. It was not the equation: `EditorPage.watchRemote` (the live query that shows content changed elsewhere) replaced the document with the copy a sync round-trip had just stored, which was older than what the person had typed since (the typed edits were still waiting for the autosave). Any sync finishing while someone typed could undo their last edits. Fix: `watchRemote` ignores a stored copy while there are unsaved edits (`typing()`), and `flush()` keeps the "unsaved" flag when an edit arrives while the save is in flight. The scenario stays as the regression test.

## Definition of done
All met, including the full regression.
