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
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../apps/web/src/app');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const en = read(join(root, 'i18n/en.json'));
const pt = read(join(root, 'i18n/pt.json'));

const flatten = (obj, prefix = '') =>
  Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? flatten(v, `${prefix}${k}.`) : [[`${prefix}${k}`, v]]));
const enKeys = new Map(flatten(en));
const ptKeys = new Map(flatten(pt));

// The permission names, groups and audit actions come from the shared package itself, so a new permission or action
// cannot ship without its texts. (Build @os-planner/shared first, as every other check here assumes.)
const shared = await import(pathToFileURL(resolve(import.meta.dirname, '../packages/shared/dist/lite.js')).href).catch(() => null);
const PERMISSION_NAMES = shared?.PERMISSION_NAMES ?? [];
const AUDIT_ACTIONS = (shared?.AUDIT_ACTIONS ?? []).map((a) => a.replaceAll('.', '_'));
const PERMISSION_GROUPS = (shared?.PERMISSION_GROUPS ?? []).map((g) => g.id);

/** Prefixes built at run time, with every suffix the code can produce. */
const DYNAMIC = {
  'editor.cmd.': ['paragraph', 'h1', 'h2', 'h3', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'divider', 'table', 'callout', 'details', 'image', 'video', 'mathBlock', 'mathInline', 'mermaid', 'chart', 'plot', 'youtube'],
  'editor.chartTypes.': ['bar', 'line', 'pie', 'doughnut', 'scatter', 'radar'],
  'editor.callout.': ['info', 'tip', 'warning', 'danger'],
  'editor.state.': ['saved', 'saving', 'offline'],
  'sync.': ['idle', 'syncing', 'offline', 'error'],
  'realtime.': ['connected', 'connecting', 'offline'],
  'presence.': ['online', 'idle', 'offline'],
  'trash.kind.': ['notebook', 'category', 'page'],
  'share.access.': ['read', 'edit'],
  'share.errors.': ['generic', 'offline', 'notFound', 'user_not_found', 'cannot_share_with_self', 'share_limit_reached', 'link_limit_reached', 'public_links_disabled', 'team_links_read_only', 'forbidden'],
  'export.scope.': ['page', 'category', 'notebook'],
  'theme.': ['system', 'light', 'dark', 'purple', 'red', 'green', 'blue', 'darkblue'],
  'apps.how.': ['windows', 'linux', 'mac', 'android', 'ios', 'other'],
  'site.f.': ['organise', 'editor', 'math', 'charts', 'media', 'pdf', 'offline', 'everywhere'].flatMap((f) => [`${f}.title`, `${f}.text`]),
  'permissions.': PERMISSION_NAMES,
  'permissions.hint.': PERMISSION_NAMES,
  'permissions.group.': PERMISSION_GROUPS,
  'overwrite.': ['allow', 'inherit', 'deny'],
  'roles.err.': ['role_at_or_above', 'permission_not_held', 'missing_manage_roles', 'everyone_protected', 'administrator_owner_only', 'last_administrator', 'role_limit_reached', 'invalid_order'],
  'team.tab.': ['members', 'invites', 'requests', 'bans', 'discover', 'roles', 'viewAs', 'audit'],
  'invite.status.': ['active', 'used', 'expired', 'revoked'],
  'invite.err.': ['invite_other_address', 'email_not_verified', 'quota_exceeded', 'invalid_role', 'project_must_be_top_level', 'role_at_or_above', 'permission_not_held', 'missing_manage_roles', 'forbidden', 'invite_closed', 'not_an_email_invite'],
  'audit.action.': AUDIT_ACTIONS,
  'audit.target.': ['team', 'project', 'user', 'invite'],
  'notif.level.': ['all', 'mentions', 'none', 'inherit'],
  'notif.email.': ['inherit', 'off', 'mentions', 'all'],
  'notif.mute.': ['15', '60', '180', '480', '1440', 'forever'],
  'notif.where.': ['default', 'here', 'global', 'team', 'project', 'channel', 'dm'],
  'notif.day.': ['0', '1', '2', '3', '4', '5', '6'],
  'notif.kind.': ['mention_user', 'mention_role', 'mention_everyone', 'mention_here', 'reply', 'dm', 'invite', 'task_assigned', 'task_due', 'task_comment', 'meeting_invite', 'meeting_reminder', 'join_request'],
  'mentions.': ['everyone', 'here'],
  'errors.': ['invalid_credentials', 'email_taken', 'password_too_common', 'offline', 'invalid_or_expired_token', 'http_429', 'generic'],
};

/** Keys the code reaches through a ternary or a variable, which text scanning cannot see. */
const EXTRA = [
  'common.ok', 'editor.mathBlock', 'editor.mathInline', 'editor.removeLink', 'editor.youtubeInvalid', 'editor.linkInvalid',
  'export.failed', 'export.mdHintPage', 'export.mdHintZip', 'auth.verifyBanner', 'auth.verifyBannerUploads',
  'sync.quotaExceeded', 'sync.uploadRefused', 'sync.conflictCopy', 'sync.restoredCopy',
  'ownership.transfer.wrongPassword', 'invite.usesOf', 'invite.uses', 'requests.approved', 'requests.denied', 'discover.invalid', 'join.open', 'join.err.banned', 'join.err.full',
  'roles.title', 'viewAs.reason.owner', 'viewAs.reason.administratorRole', 'viewAs.reason.administratorEveryone', 'viewAs.reason.base',
  'viewAs.reason.member', 'viewAs.reason.allowed', 'viewAs.reason.denied', 'viewAs.reason.masked', 'viewAs.reason.none',
];

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(ts|html)$/.test(name) && !name.endsWith('.spec.ts')) yield p;
  }
}

const used = new Set();
if (!shared) console.error('packages/shared is not built (npm run build -w @os-planner/shared): permission and audit texts cannot be checked.');
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
