#!/usr/bin/env node
// Demo data for screenshots and manual testing: a team with projects, roles, channels and messages, a direct conversation, notebooks
// with pages, a board with tasks, meetings, a calendar feed and a share link. Everything goes through the API of a running server, the
// way the website would do it; only "this address is verified" is written to the database (there is no mailbox to click in).
//
//   npm run seed:demo                                  against http://localhost:3000 and the DATABASE_URL of .env
//   SEED_API_URL=https://planner.example.com npm run seed:demo
//
// The server must list demo-admin@example.com in ADMIN_EMAILS. Accounts (password "planner demo 2026"):
//   demo-admin@example.com (instance admin), olivia@example.com (owner), max@example.com, ana@example.com, sam@example.com
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { api, uuidv7 } from './load/lib.mjs';

const root = resolve(import.meta.dirname, '..');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const base = (process.env.SEED_API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(
  /\/+$/,
  '',
);
const PASSWORD = 'planner demo 2026';
const people = {
  admin: { email: 'demo-admin@example.com', name: 'Dee Admin' },
  olivia: { email: 'olivia@example.com', name: 'Olivia Owner' },
  max: { email: 'max@example.com', name: 'Max Developer' },
  ana: { email: 'ana@example.com', name: 'Ana Designer' },
  sam: { email: 'sam@example.com', name: 'Sam Guest' },
};

async function sql(statement, params) {
  const mariadb = createRequire(resolve(root, 'apps/server/package.json'))('mariadb');
  const u = new URL(process.env.DATABASE_URL);
  const conn = await mariadb.createConnection({
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
    allowPublicKeyRetrieval: true,
  });
  try {
    return await conn.query(statement, params);
  } finally {
    await conn.end();
  }
}

/** Signs the person in, creating the account first if needed; the address is marked verified. */
async function account(p) {
  let res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: p.email, password: PASSWORD }),
  });
  if (res.status === 401) {
    await api(base).post('/api/auth/register', {
      email: p.email,
      password: PASSWORD,
      displayName: p.name,
    });
    res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: p.email, password: PASSWORD }),
    });
  }
  if (!res.ok) throw new Error(`sign-in of ${p.email} failed: ${res.status} ${await res.text()}`);
  await sql(
    'UPDATE `User` SET emailVerifiedAt = COALESCE(emailVerifiedAt, NOW(3)) WHERE email = ?',
    [p.email],
  );
  const body = await res.json();
  // a fresh token after verification (the old one is fine for the API, the web reads the flag from /me)
  return { ...p, id: body.user.id, token: body.accessToken, call: api(base, body.accessToken) };
}

const doc = (...paragraphs) => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});
const at = (days, hour, minutes = 0) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hour, minutes, 0, 0);
  return d.toISOString();
};

const health = await fetch(`${base}/api/health`).catch(() => null);
if (!health?.ok)
  throw new Error(`no OS_Planner server answers at ${base} (start it first, or set SEED_API_URL)`);

const admin = await account(people.admin);
const olivia = await account(people.olivia);
const max = await account(people.max);
const ana = await account(people.ana);
const sam = await account(people.sam);

const teams = await admin.call.get('/api/admin/teams').catch(() => {
  throw new Error(
    'demo-admin@example.com is not an instance administrator: add it to ADMIN_EMAILS and restart the server',
  );
});
if (teams.some((t) => t.name === 'Acme Studio')) {
  console.log(
    'the demo team "Acme Studio" is already there: nothing to do (delete it in Administration to seed again)',
  );
  process.exit(0);
}

// ---- the team, its people and roles
const team = await admin.call.post('/api/admin/teams', {
  name: 'Acme Studio',
  ownerEmail: olivia.email,
  isPublic: true,
  joinPolicy: 'request',
});
await olivia.call.patch(`/api/teams/${team.id}`, {
  description: 'A small design and software studio (demo data).',
  allowMemberDMs: true,
  allowPublicLinks: true,
});
const link = await olivia.call.post(`/api/teams/${team.id}/invites`, {
  link: true,
  maxUses: 10,
  expiresInDays: 7,
});
const token = String(link.url).split('/').pop();
for (const who of [max, ana, sam]) await who.call.post('/api/invites/accept', { token });
const roles = await olivia.call.get(`/api/teams/${team.id}/roles`);
const everyone = roles.find((r) => r.isEveryone);
// what a member may do by default here: talk, write pages, work on tasks, make meetings
const P = (n) => 1n << BigInt(n);
const MEMBER =
  BigInt(everyone.permissions) |
  P(18) |
  P(19) |
  P(20) |
  P(24) |
  P(25) |
  P(26) |
  P(30) |
  P(10) |
  P(11) |
  P(12) |
  P(13);
await olivia.call.patch(`/api/roles/${everyone.id}`, { permissions: MEMBER.toString() });
const lead = await olivia.call.post(`/api/teams/${team.id}/roles`, {
  name: 'Lead',
  color: '#e8590c',
  hoist: true,
  mentionable: true,
  permissions: (MEMBER | P(15) | P(16) | P(21) | P(22) | P(27) | P(28) | P(31) | P(6)).toString(),
});
const guest = await olivia.call.post(`/api/teams/${team.id}/roles`, {
  name: 'Guest',
  color: '#868e96',
  mentionable: false,
});
await olivia.call.put(`/api/teams/${team.id}/members/${max.id}/roles/${lead.id}`);
await olivia.call.put(`/api/teams/${team.id}/members/${sam.id}/roles/${guest.id}`);
const teamRow = (await sql('SELECT spaceId FROM `Team` WHERE id = ?', [team.id]))[0];

// ---- projects
const website = await olivia.call.post(`/api/teams/${team.id}/projects`, {
  name: 'Website relaunch',
  color: '#1c7ed6',
  position: 'a0',
});
const launch = await olivia.call.post(`/api/teams/${team.id}/projects`, {
  name: 'Launch',
  parentId: website.id,
  position: 'a0',
});
const mobile = await olivia.call.post(`/api/teams/${team.id}/projects`, {
  name: 'Mobile app',
  color: '#2f9e44',
  position: 'a1',
});
for (const p of [website, launch, mobile])
  for (const who of [max, ana])
    await olivia.call
      .post(`/api/projects/${p.id}/members`, { userId: who.id })
      .catch(() => undefined);

// ---- chat
const general = await olivia.call.post(`/api/spaces/${teamRow.spaceId}/channels`, {
  name: 'general',
  topic: 'Everything and nothing',
});
const design = await olivia.call.post(`/api/spaces/${website.spaceId}/channels`, {
  name: 'design',
  topic: 'Mock-ups and reviews',
});
const say = (who, channel, content) =>
  who.call.post(`/api/channels/${channel.id}/messages`, { id: uuidv7(), content });
await say(olivia, general, 'Welcome to **Acme Studio** on OS_Planner! :wave:');
await say(
  max,
  general,
  'Hi all. The board for the relaunch is up, see the *Website relaunch* project.',
);
await say(ana, general, `@${'Max Developer'} the new colours are in the design notebook.`);
const first = await say(ana, design, 'First round of mock-ups: home, pricing and blog.');
await max.call.post(`/api/messages/${first.id}/thread`, { name: 'Mock-up feedback' });
await max.call.put(`/api/messages/${first.id}/reactions/${encodeURIComponent('👍')}`);
await olivia.call.put(`/api/messages/${first.id}/pin`).catch(() => undefined);
const dm = await olivia.call.post('/api/dms', { userId: ana.id });
await olivia.call.post(`/api/channels/${dm.channelId}/messages`, {
  id: uuidv7(),
  content: 'Can we look at the logo on Thursday?',
});
await ana.call.post(`/api/channels/${dm.channelId}/messages`, {
  id: uuidv7(),
  content: 'Sure, 10:00 works for me.',
});

// ---- notebooks and pages
async function notebook(who, spaceId, name, pages) {
  const id = randomUUID();
  await who.call.post('/api/notebooks', {
    id,
    ...(spaceId ? { spaceId } : {}),
    name,
    position: 'a0',
  });
  const tree = await who.call.get(`/api/notebooks/${id}/tree`);
  let n = 0;
  for (const [title, ...text] of pages) {
    const page = randomUUID();
    await who.call.post('/api/pages', {
      id: page,
      categoryId: tree.categories[0].id,
      title,
      position: `a${n++}`,
    });
    await who.call.post(`/api/pages/${page}/snapshots/replace`, {
      content: doc(...text),
      baseVersion: 0,
    });
  }
  return id;
}
const handbook = await notebook(olivia, teamRow.spaceId, 'Team handbook', [
  [
    'Welcome',
    'Start here: how we work, where things live and who to ask.',
    'Chat for quick questions, boards for work, pages for what should last.',
  ],
  ['Meetings', 'Planning every Monday at 10:00, a demo every other Friday.'],
]);
await notebook(ana, website.spaceId, 'Design', [
  ['Colours', 'Primary #1c7ed6, accent #e8590c, text #212529.'],
  ['Typography', 'Inter for text, JetBrains Mono for code.'],
]);
await notebook(max, null, 'My notes', [['Ideas', 'Try the offline mode on the train.']]);
const shareLink = await olivia.call.post(`/api/notebooks/${handbook}/links`, { access: 'read' });

// ---- a board
const board = randomUUID();
await max.call.post(`/api/spaces/${website.spaceId}/boards`, {
  id: board,
  name: 'Relaunch',
  position: 'a0',
});
const detail = await max.call.get(`/api/boards/${board}`);
const col = Object.fromEntries(detail.columns.map((c) => [c.kind, c.id]));
const label = async (name, color) => {
  const id = randomUUID();
  await max.call.post(`/api/spaces/${website.spaceId}/labels`, { id, name, color });
  return id;
};
const bug = await label('Bug', '#e03131');
const feature = await label('Feature', '#1c7ed6');
let n = 0;
const task = async (title, column, extra = {}) => {
  const id = randomUUID();
  await max.call.post(`/api/boards/${board}/tasks`, {
    id,
    columnId: column,
    position: `a${n++}`,
    title,
    ...extra,
  });
  return id;
};
await task('Pricing page copy', col.todo, {
  labelIds: [feature],
  assigneeIds: [ana.id],
  dueAt: at(5, 17),
  priority: 'high',
});
const cms = await task('Move the blog to the new CMS', col.doing, {
  labelIds: [feature],
  assigneeIds: [max.id],
});
await max.call.post(`/api/tasks/${cms}/checklist`, {
  id: randomUUID(),
  text: 'Export old posts',
  position: 'a0',
});
await max.call.post(`/api/tasks/${cms}/checklist`, {
  id: randomUUID(),
  text: 'Redirects',
  position: 'a1',
});
await max.call.post(`/api/tasks/${cms}/comments`, {
  id: randomUUID(),
  content: 'Half of the posts are moved.',
});
await task('Broken link in the footer', col.todo, { labelIds: [bug], priority: 'urgent' });
await task('Choose the hosting', col.done, { assigneeIds: [olivia.id], completed: true }).catch(
  () => task('Choose the hosting', col.done),
);

// ---- the calendar
await olivia.call.post('/api/events', {
  id: randomUUID(),
  spaceId: teamRow.spaceId,
  title: 'Weekly planning',
  kind: 'meeting',
  startAt: at(1, 9),
  endAt: at(1, 10),
  timezone: 'Europe/Lisbon',
  rrule: 'FREQ=WEEKLY;BYDAY=MO',
  visibility: 'space',
  attendees: [max, ana, sam].map((p) => ({ kind: 'user', subjectId: p.id })),
});
await ana.call.post('/api/events', {
  id: randomUUID(),
  spaceId: website.spaceId,
  title: 'Design review',
  kind: 'meeting',
  startAt: at(3, 14),
  endAt: at(3, 15),
  visibility: 'space',
});
await sam.call.post('/api/events', {
  id: randomUUID(),
  spaceId: (await sam.call.get('/api/me')).personalSpaceId,
  title: 'Dentist',
  kind: 'event',
  startAt: at(2, 8),
  endAt: at(2, 9),
});
const feed = await olivia.call.post('/api/me/feeds', { name: 'My phone' });

console.log(`demo data ready at ${base}
  sign in as olivia@example.com (owner), max@example.com (lead), ana@example.com, sam@example.com (guest), demo-admin@example.com (admin)
  password for all: "${PASSWORD}"
  a read link to the team handbook: ${shareLink.url}
  Olivia's calendar feed: ${feed.url}
  (the mock-up thread, pinned message, direct conversation, board, labels and the weekly meeting are in place)`);
void mobile;
