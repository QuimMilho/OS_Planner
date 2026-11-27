#!/usr/bin/env node
// Bundle budgets of phase 17 (section C), measured gzipped on the production build:
//   - the initial bundle (what index.html loads before the app runs) <= 520 kB
//   - each lazily loaded feature route (boards, calendar, admin, voice, history) < 150 kB: its own chunks and the chunks only it
//     imports statically (chunks loaded later with import(), like the media library of voice calls, are listed apart)
//
//   npm run build -w @os-planner/web -- --stats-json && node scripts/check-bundle.mjs
//
// Exit 1 when a budget is exceeded. `--json` prints the numbers only.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'apps/web/dist/web');
const browser = resolve(dist, 'browser');
const statsFile = resolve(dist, 'browser-stats.json');
const INITIAL_BUDGET = 520 * 1024;
const ROUTE_BUDGET = 150 * 1024;
const ROUTES = {
  boards: 'features/boards/',
  calendar: 'features/calendar/',
  admin: 'features/admin/',
  voice: 'features/voice/',
  history: 'features/history/',
};

if (!existsSync(resolve(browser, 'index.html')))
  throw new Error('no web build: npm run build -w @os-planner/web -- --stats-json');
const gz = (file) => gzipSync(readFileSync(resolve(browser, file)), { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

// ---- the initial bundle: scripts, module preloads and stylesheets of index.html
const html = readFileSync(resolve(browser, 'index.html'), 'utf8');
const initial = new Set();
for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+\.(?:js|css))"/g))
  if (!/^https?:/.test(m[1])) initial.add(m[1].replace(/^\//, ''));

// what those files import statically is loaded at once too
let meta = null;
if (existsSync(statsFile)) meta = JSON.parse(readFileSync(statsFile, 'utf8'));
const outputs = meta
  ? Object.fromEntries(
      Object.entries(meta.outputs).map(([k, v]) => [
        k.replace(/^.*?browser[\\/]/, '').replace(/\\/g, '/'),
        v,
      ]),
    )
  : {};
const staticImports = (file) =>
  (outputs[file]?.imports ?? [])
    .filter((i) => i.kind === 'import-statement')
    .map((i) => i.path.replace(/^.*?browser[\\/]/, '').replace(/\\/g, '/'));
const closure = (start) => {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const i of staticImports(f)) walk(i);
  };
  for (const s of start) walk(s);
  return seen;
};
const initialAll = meta
  ? closure([...initial].filter((f) => f.endsWith('.js')))
  : new Set([...initial].filter((f) => f.endsWith('.js')));
for (const f of initial) if (f.endsWith('.css')) initialAll.add(f);
const initialBytes = [...initialAll]
  .filter((f) => existsSync(resolve(browser, f)))
  .reduce((a, f) => a + gz(f), 0);

const results = {
  initial: {
    gzip: initialBytes,
    budget: INITIAL_BUDGET,
    files: initialAll.size,
    ok: initialBytes <= INITIAL_BUDGET,
  },
  routes: {},
};

// ---- the feature routes: the chunks esbuild made for files of that feature (their entry points), and their own static imports
if (meta) {
  const entryOf = (f) => (outputs[f]?.entryPoint ?? '').replace(/\\/g, '/');
  const lazy = Object.keys(outputs).filter((f) => f.endsWith('.js') && !initialAll.has(f));
  const owners = new Map(); // chunk -> features that reach it statically
  const routeChunks = {};
  for (const [name, dir] of Object.entries(ROUTES)) {
    const entries = lazy.filter(
      (f) =>
        entryOf(f).includes(`src/app/${dir}`) ||
        Object.keys(outputs[f]?.inputs ?? {}).some((i) =>
          i.replace(/\\/g, '/').includes(`src/app/${dir}`),
        ),
    );
    const reach = [...closure(entries)].filter((f) => !initialAll.has(f));
    routeChunks[name] = reach;
    for (const f of reach) owners.set(f, [...(owners.get(f) ?? []), name]);
  }
  for (const [name, reach] of Object.entries(routeChunks)) {
    const own = reach.filter((f) => owners.get(f)?.length === 1);
    const shared = reach.filter((f) => (owners.get(f)?.length ?? 0) > 1);
    const bytes = own.reduce((a, f) => a + gz(f), 0);
    const later = [
      ...new Set(
        own.flatMap((f) =>
          (outputs[f]?.imports ?? [])
            .filter((i) => i.kind === 'dynamic-import')
            .map((i) => i.path.replace(/^.*?browser[\\/]/, '').replace(/\\/g, '/')),
        ),
      ),
    ].filter((f) => !reach.includes(f) && !initialAll.has(f));
    results.routes[name] = {
      gzip: bytes,
      budget: ROUTE_BUDGET,
      ok: bytes < ROUTE_BUDGET,
      chunks: own.length,
      sharedWithOtherRoutes: shared.reduce((a, f) => a + gz(f), 0),
      loadedLater: later.reduce((a, f) => a + (existsSync(resolve(browser, f)) ? gz(f) : 0), 0),
    };
  }
}

if (process.argv.includes('--json')) console.log(JSON.stringify(results, null, 2));
else {
  console.log(
    `initial bundle: ${kb(results.initial.gzip)} gzipped (${results.initial.files} files; budget ${kb(INITIAL_BUDGET)}) ${results.initial.ok ? 'ok' : 'OVER'}`,
  );
  if (!meta)
    console.log('(no browser-stats.json: build with --stats-json to measure the feature routes)');
  for (const [name, r] of Object.entries(results.routes))
    console.log(
      `  ${name.padEnd(9)} ${kb(r.gzip).padStart(9)} (budget ${kb(ROUTE_BUDGET)}) ${r.ok ? 'ok' : 'OVER'}   shared with other routes ${kb(r.sharedWithOtherRoutes)}, loaded later ${kb(r.loadedLater)}`,
    );
}
const ok = results.initial.ok && Object.values(results.routes).every((r) => r.ok);
process.exit(ok ? 0 : 1);
