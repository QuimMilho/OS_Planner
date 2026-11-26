# Phase 1: Themes

## Goal
Seven selectable themes (light, dark, purple, red, green, blue, dark blue). The choice belongs to the account: it follows the person to every device and is restored at login. With no choice the OS decides (light or dark). The coloured themes are dark and understated, the colour is the accent, and the background does not have to be that colour.

**Depends on:** phase 0 (none functionally). **Independent**: may ship before everything else.

## In scope / Out of scope
- In: palettes, picker with live preview, per-account storage, no-flash boot, print/PDF unaffected, e-mail templates unaffected.
- Out: user-defined colours, per-team themes, scheduled (time-of-day) switching.

## Data model
`User.theme VARCHAR(10)` already exists (`system | light | dark`). Widen to `VARCHAR(16)`; allowed values: `system, light, dark, purple, red, green, blue, darkblue`. Migration: widen the column; existing values stay valid. `system` means "follow the OS" and is the default for new and unchanged accounts.

## API
- `GET/PATCH /api/me` carry `theme` (existing). The zod `Theme` enum in `packages/shared/src/dto` gains the five values. Unknown values → 400.
- The login/refresh response already includes the user, so the theme arrives with the session.

## Web UI
- `core/theme.ts` (`ThemeService`):
  - effective theme = `user.theme` if signed in, else the last locally stored value, else `system`;
  - `system` removes `data-theme` and lets `prefers-color-scheme` decide; otherwise sets `<html data-theme="…">`;
  - listens to `matchMedia('(prefers-color-scheme: dark)')` while `system` is active;
  - saves to the account via `PATCH /api/me` and writes `localStorage` as a cache for logged-out screens and the next boot.
- `styles.scss`: one palette block per theme, set through `mat.theme(...)` with a seed colour for primary and tertiary, plus the app's CSS variables (`--surface`, `--surface-2`, `--surface-3`, `--border`, `--text`, `--text-dim`, `--accent`). Coloured themes are *dark* schemes: surfaces are tinted neutrals (about 8–14 % lightness), the accent is the hue, not the whole background. `color-scheme` is set so native controls match.
- No flash: a `theme-boot.js` file in `public/` (the CSP forbids inline scripts) loaded synchronously in `<head>` sets `data-theme` from `localStorage` before first paint. Included in the ngsw prefetch group.
- Settings → Appearance: a grid of seven cards, each a live mini-preview (surface, accent, text) with the current one marked; keyboard accessible (`radiogroup`).
- Code-block, callout, chart and Mermaid colours follow the active theme (Mermaid theme chosen from light/dark of the scheme). PDF/print output stays light always.
- Theme colour for the PWA (`<meta name="theme-color">`) follows the active theme.

## i18n keys
`settings.appearance.title`, `settings.appearance.hint`, `theme.system`, `theme.light`, `theme.dark`, `theme.purple`, `theme.red`, `theme.green`, `theme.blue`, `theme.darkblue` (en + pt-PT: Roxo, Vermelho, Verde, Azul, Azul escuro).

## Security & permissions
Own account only. Value validated server-side against the enum.

## Quota impact
None.

## Implementation steps
1. Extend the `Theme` type/enum in `packages/shared` and the profile DTO; widen the column (migration).
2. Define the seven palettes; verify contrast programmatically (script in `scripts/` computing WCAG ratios of `--text` on every surface and `--accent` on `--surface`).
3. `theme-boot.js` + `index.html` + ngsw config.
4. Rewrite `ThemeService` (OS listener, account sync, cache).
5. Appearance section in Settings with previews.
6. Make editor/Mermaid/Chart colours read CSS variables.
7. i18n strings; docs.

## Acceptance criteria
1. [server] `PATCH /api/me {theme}` accepts each of the eight values and rejects `neon`; the value comes back on `GET /api/me`. (`auth.test.ts`)
2. [unit] `scripts/check-theme-contrast` passes: body text ≥ 4.5:1 and accent-on-surface ≥ 3:1 for every theme; UI borders ≥ 1.5:1.
3. [web e2e] Fresh profile with `colorScheme: 'dark'` and no choice → `<html>` has no `data-theme` and the page is dark; with `colorScheme: 'light'` it is light.
4. [web e2e] Choosing each of the seven themes sets `data-theme`, changes `--accent`, and persists across reload.
5. [web e2e] Choose "purple" on device A; sign in on a fresh device B → purple is applied before the app shell is interactive (no frame of another theme: check the first `data-theme` mutation).
6. [web e2e] A logged-in account with `system` follows a live OS switch (`page.emulateMedia`) without reload.
7. [web e2e] A theme that is chosen while offline is saved locally and sent to the account when the connection returns.
8. [web e2e] PDF export under a coloured theme is identical in colours to light-theme export (compare the print HTML; no theme variables leak).
9. [manual] Visual pass of the editor, tree, dialogs, charts and snackbars in all seven themes.

## Definition of done
See [overview §4.3](overview.md#43-definition-of-done-all-phases). Screenshots of the seven themes added to the README.

## Result (done 2026-11-25)
Scripts 23 (+10) · shared 71 (+1) · server 179 (+1) · web e2e 32 (+8, `themes.e2e.mjs`) · desktop 7. Criteria 1-8 are automated (8 as a shared unit test: the print HTML and CSS use no theme variables; the PDF renderer takes no theme input). Criterion 9 (visual pass) was done on screenshots of the editor, chart, Mermaid diagram, callout and code in every theme; the README carries them (`docs/themes/`).

How it differs from the plan above:
- **Palettes** live in `apps/web/src/themes.scss` (not `styles.scss`). Material's built-in hue palettes are far too saturated (the green accent was neon), so the coloured themes build their accent ramp and tinted neutrals from a hue with HSL. `dark-blue` has navy surfaces; the others keep nearly neutral ones.
- **Contrast script**: `scripts/check-theme-contrast.mjs` (+ `scripts/lib/theme-contrast.mjs`) compiles the real SCSS with `sass` and measures the resolved colours. Besides the plan's checks it requires a readable dim text and button label, dark surfaces (≤ 14 % lightness) for the coloured themes, a different accent per theme, and that the shared `THEMES` list, `theme-boot.js` and the stylesheet name the same ids (`npm run check:themes`).
- **Theme attribute on any element**: tokens apply to any `[data-theme]`, which is how each picker card previews its own theme live.
- **Picker**: eight cards, the seven themes plus "Same as device". Language moved to its own card. `settings.appearance` became an object (`title`, `hint`); the `theme.*` strings are a top-level group.
- **Offline choice**: `os_planner.theme.pending` marks a choice not yet on the account; it is sent on the `online` event and at the next start, and wins over the account's value until delivered.
- **Charts and diagrams**: Chart.js gets the page's text and grid colours and Mermaid its light/dark look; both redraw when the theme changes (`ThemeService.palette`/`scheme`). Code colours became `--hl-*` variables.
- **Bundle budget**: the seven palettes add ~7 kB of CSS, so the initial-bundle error budget in `angular.json` went from 2 MB to 2.1 MB.
- Bug found on the way (phase 0's open item): see [phase-0.md](phase-0.md#result).
