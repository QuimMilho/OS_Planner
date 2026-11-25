// Verifies the translation files against the source:
//   - every key the code uses exists in en.json and pt.json
//   - en.json and pt.json have exactly the same keys
//   - no placeholder ({{x}}) is present in one language but missing in the other
// Dynamic keys ("editor.cmd." + id) are checked through the DYNAMIC table below.
//
//   node scripts/i18n-check.mjs          check (exit 1 on problems)
//   node scripts/i18n-check.mjs --list   print the static keys and dynamic prefixes found in the source
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../apps/web/src/app');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const en = read(join(root, 'i18n/en.json'));
const pt = read(join(root, 'i18n/pt.json'));

const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]));
const enKeys = new Map(flatten(en));
const ptKeys = new Map(flatten(pt));

/** Prefixes built at run time, with every suffix the code can produce. */
const DYNAMIC = {
  'editor.cmd.': ['paragraph', 'h1', 'h2', 'h3', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'divider', 'table', 'callout', 'details', 'image', 'video', 'mathBlock', 'mathInline', 'mermaid', 'chart', 'plot', 'youtube'],
  'editor.chartTypes.': ['bar', 'line', 'pie', 'doughnut', 'scatter', 'radar'],
  'editor.callout.': ['info', 'tip', 'warning', 'danger'],
  'editor.state.': ['saved', 'saving', 'offline'],
  'sync.': ['idle', 'syncing', 'offline', 'error'],
  'trash.kind.': ['notebook', 'category', 'page'],
  'export.scope.': ['page', 'category', 'notebook'],
  'theme.': ['system', 'light', 'dark', 'purple', 'red', 'green', 'blue', 'darkblue'],
  'apps.how.': ['windows', 'linux', 'mac', 'android', 'ios', 'other'],
  'site.f.': ['organise', 'editor', 'math', 'charts', 'media', 'pdf', 'offline', 'everywhere'].flatMap((f) => [`${f}.title`, `${f}.text`]),
  'errors.': ['invalid_credentials', 'email_taken', 'password_too_common', 'offline', 'invalid_or_expired_token', 'http_429', 'generic'],
};

/** Keys the code reaches through a ternary or a variable, which text scanning cannot see. */
const EXTRA = [
  'common.ok', 'editor.mathBlock', 'editor.mathInline', 'editor.removeLink', 'editor.youtubeInvalid', 'editor.linkInvalid',
  'export.failed', 'export.mdHintPage', 'export.mdHintZip', 'auth.verifyBanner', 'auth.verifyBannerUploads',
  'sync.quotaExceeded', 'sync.uploadRefused', 'sync.conflictCopy', 'sync.restoredCopy',
];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|html)$/.test(name) && !name.endsWith('.spec.ts')) yield p;
  }
}

const used = new Set();
const prefixes = new Set();
const KEY = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+)+$/;
for (const file of files(root)) {
  const src = readFileSync(file, 'utf8');
  // 'a.b.c' | transloco   and   'a.b' | transloco: {...}
  for (const m of src.matchAll(/'([^']+)'\s*\|\s*transloco/g)) if (KEY.test(m[1])) used.add(m[1]);
  // x.t('a.b'), notify.info('a.b'), notify.error('a.b')
  for (const m of src.matchAll(/(?:\.t|\.info|\.error)\(\s*'([^']+)'/g)) if (KEY.test(m[1])) used.add(m[1]);
  // titleKey: 'a.b', messageKey, labelKey, confirmKey, secondaryKey, messageKey
  for (const m of src.matchAll(/(?:titleKey|messageKey|labelKey|confirmKey|secondaryKey|key)\s*:\s*'([^']+)'/g)) if (KEY.test(m[1])) used.add(m[1]);
  // label: 'editor.x'  (toolbar tables)
  for (const m of src.matchAll(/label:\s*'([a-z][A-Za-z.]+)'/g)) if (KEY.test(m[1])) used.add(m[1]);
  // dynamic: 'prefix.' + something
  for (const m of src.matchAll(/'([a-z][A-Za-z0-9.]*\.)'\s*\+/g)) prefixes.add(m[1]);
  for (const m of src.matchAll(/\(\s*'([a-z][A-Za-z0-9.]*\.)'\s*\+/g)) prefixes.add(m[1]);
  // template literals: `editor.cmd.${id}`, `errors.${code}`
  for (const m of src.matchAll(/`([a-z][A-Za-z0-9.]*\.)\$\{/g)) prefixes.add(m[1]);
}
for (const key of EXTRA) used.add(key);

if (process.argv.includes('--list')) {
  console.log([...used].sort().join('\n'));
  console.log('\n# dynamic prefixes\n' + [...prefixes].sort().join('\n'));
  process.exit(0);
}

const problems = [];
for (const key of [...used].sort()) {
  if (!enKeys.has(key)) problems.push(`missing in en.json: ${key}`);
  if (!ptKeys.has(key)) problems.push(`missing in pt.json: ${key}`);
}
for (const prefix of prefixes) {
  if (!(prefix in DYNAMIC)) {
    problems.push(`dynamic prefix "${prefix}" is not listed in DYNAMIC (add its suffixes to scripts/i18n-check.mjs)`);
    continue;
  }
  for (const suffix of DYNAMIC[prefix]) {
    for (const [name, table] of [['en', enKeys], ['pt', ptKeys]]) if (!table.has(prefix + suffix)) problems.push(`missing in ${name}.json: ${prefix}${suffix}`);
  }
}
for (const key of enKeys.keys()) if (!ptKeys.has(key)) problems.push(`only in en.json: ${key}`);
for (const key of ptKeys.keys()) if (!enKeys.has(key)) problems.push(`only in pt.json: ${key}`);
const params = (s) => [...String(s).matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort().join(',');
for (const [key, value] of enKeys) if (ptKeys.has(key) && params(value) !== params(ptKeys.get(key))) problems.push(`placeholders differ for ${key}`);
const allUsed = new Set([...used, ...Object.entries(DYNAMIC).flatMap(([p, s]) => s.map((x) => p + x))]);
const unused = [...enKeys.keys()].filter((k) => !allUsed.has(k));

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`i18n ok: ${enKeys.size} keys in en and pt, ${used.size} static + ${prefixes.size} dynamic prefixes checked` + (unused.length ? `\n(unused keys: ${unused.join(', ')})` : ''));
