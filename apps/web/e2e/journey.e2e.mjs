// End-to-end, phase 17 (acceptance 7): the whole journey of a team on a fresh install, with several people in their own browsers.
// The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Permission, permissionsToString, positionBetween } from '@os-planner/shared';
import {
  linkIn,
  login,
  register,
  sql,
  startStack,
  uniqueEmail,
  verify,
  waitForMail,
  launch,
  waitSaved,
} from './harness.mjs';

const T = { timeout: 600_000 };
const ADMIN_EMAIL = uniqueEmail('journeyadmin');

let stack;
let browser;
let base;

before(async () => {
  stack = await startStack({
    env: {
      ADMIN_EMAILS: ADMIN_EMAIL,
      NOTIFY_AWAY_SECONDS: '3',
      NOTIFY_SWEEP_SECONDS: '2',
      NOTIFY_PUSH_COALESCE_SECONDS: '0',
    },
  });
  base = stack.baseUrl;
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await stack?.stop();
});

async function device() {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(25_000);
  const problems = [];
  page.on(
    'console',
    (m) =>
      /Content Security Policy|violates the following/i.test(m.text()) &&
      problems.push(m.text().slice(0, 200)),
  );
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));
  return { ctx, page, problems, close: () => ctx.close() };
}

async function person(name, email = uniqueEmail('journey')) {
  const d = await device();
  await register(d.page, base, { name, email });
  await verify(d.page, email);
  await d.page.goto(`${base}/app`);
  await d.page.waitForSelector('app-rail');
  const id = (await sql('SELECT id FROM `User` WHERE email = ?', [email]))[0].id;
  return { ...d, email, id, name };
}

async function api(page, method, path, body) {
  return page.evaluate(
    async ([m, p, b]) => {
      const refresh = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'X-Requested-With': 'os_planner' },
      });
      const { accessToken } = await refresh.json();
      const res = await fetch(p, {
        method: m,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(b ? { 'Content-Type': 'application/json' } : {}),
        },
        body: b ? JSON.stringify(b) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [method, path, body ?? null],
  );
}
const ok = async (call, what) => {
  const res = await call;
  assert.ok(res.status < 300, `${what}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
let lastPos = null;
const pos = () => (lastPos = positionBetween(lastPos, null));
const uuidv7 = () => {
  const ms = Date.now().toString(16).padStart(12, '0');
  const r = randomUUID().replace(/-/g, '');
  return `${ms.slice(0, 8)}-${ms.slice(8)}-7${r.slice(0, 3)}-8${r.slice(4, 7)}-${r.slice(7, 19)}`;
};
const until = async (fn, ms = 45_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 500));
  }
};
const goOnline = async (who) => {
  await who.ctx.setOffline(false);
  await who.page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
};

describe('the journey of a team', () => {
  test(
    'from an empty instance to a team that chats, co-edits, plans, follows its calendar and works offline',
    T,
    async () => {
      // ---- 1. the administrator creates a team and names an owner who has no account yet
      const admin = await person('Ada Admin', ADMIN_EMAIL);
      const ownerEmail = uniqueEmail('journeyowner');
      await admin.page.goto(`${base}/app/admin`);
      await admin.page.waitForSelector('[data-admin-teams]');
      await admin.page.fill('input[name=teamName]', 'Journey Team');
      await admin.page.fill('input[name=teamOwner]', ownerEmail);
      await admin.page.click('[data-create-team]');
      await admin.page.locator('[data-team-row="Journey Team"]').waitFor();
      const [team] = await sql('SELECT t.id, t.spaceId, t.ownerId FROM `Team` t WHERE t.name = ?', [
        'Journey Team',
      ]);
      assert.equal(team.ownerId, null, 'the team waits for its owner');

      // ---- 2. the owner is told by mail, registers with that address, and the team is theirs
      const offer = await waitForMail(ownerEmail, '');
      assert.ok(linkIn(offer), 'the mail links to the site');
      const owner = await person('Olivia Owner', ownerEmail);
      await until(
        async () =>
          (await sql('SELECT ownerId FROM `Team` WHERE id = ?', [team.id]))[0].ownerId === owner.id,
      );
      await owner.page.goto(`${base}/app/t/${team.id}`);
      await owner.page.waitForSelector('app-rail');

      // ---- 3. projects, a sub-project, a role and an overwrite; an invite link
      const project = await ok(
        api(owner.page, 'POST', `/api/teams/${team.id}/projects`, {
          name: 'Website',
          position: pos(),
        }),
        'project',
      );
      const sub = await ok(
        api(owner.page, 'POST', `/api/teams/${team.id}/projects`, {
          name: 'Launch',
          parentId: project.id,
          position: pos(),
        }),
        'sub-project',
      );
      const editors = await ok(
        api(owner.page, 'POST', `/api/teams/${team.id}/roles`, {
          name: 'Editors',
          mentionable: true,
          permissions: permissionsToString(
            Permission.EDIT_PAGES |
              Permission.CREATE_TASKS |
              Permission.EDIT_TASKS |
              Permission.CREATE_MEETINGS,
          ),
        }),
        'role',
      );
      await ok(
        api(owner.page, 'PUT', '/api/overwrites', {
          targetKind: 'project',
          targetId: sub.id,
          subjectKind: 'role',
          subjectId: editors.id,
          allow: permissionsToString(Permission.MANAGE_BOARDS),
        }),
        'overwrite',
      );
      const link = await ok(
        api(owner.page, 'POST', `/api/teams/${team.id}/invites`, {
          link: true,
          roleIds: [editors.id],
        }),
        'invite link',
      );

      // ---- 4. a member joins by the link
      const member = await person('Max Member');
      await member.page.goto(link.url.replace(/^https?:\/\/[^/]+/, base));
      await member.page.click('[data-action=invite-join]');
      await until(
        async () =>
          (
            await sql('SELECT COUNT(*) AS n FROM `TeamMember` WHERE teamId = ? AND userId = ?', [
              team.id,
              member.id,
            ])
          )[0].n > 0,
      );
      const roles = await sql('SELECT roleId FROM `MemberRole` WHERE userId = ?', [member.id]);
      assert.ok(
        roles.some((r) => r.roleId === editors.id),
        'the link handed out its role',
      );

      // ---- 5. chat: a mention, the bell, mute, and email when away
      const channel = await ok(
        api(owner.page, 'POST', `/api/spaces/${team.spaceId}/channels`, { name: 'general' }),
        'channel',
      );
      await member.page.goto(`${base}/app/c/${channel.id}`);
      await member.page.waitForSelector('[data-channel-page]');
      await owner.page.goto(`${base}/app/c/${channel.id}`);
      await owner.page.waitForSelector('[data-channel-page]');
      const box = owner.page.locator('[data-composer-input]');
      await box.click();
      await box.pressSequentially('Welcome ');
      await box.pressSequentially('@Max');
      await owner.page.locator('[data-mention-option="@Max Member"]').click();
      await box.press('Enter');
      await member.page.locator('[data-msg-id]', { hasText: 'Welcome' }).first().waitFor();
      await member.page.waitForFunction(
        () => Number(document.querySelector('[data-bell-badge]')?.textContent?.trim() ?? '0') >= 1,
      );
      // muted for an hour: @everyone there makes no notification (a direct mention still would: that is what mutes are for)
      await ok(
        api(member.page, 'POST', '/api/notification-settings/mute', {
          scopeKind: 'channel',
          scopeId: channel.id,
          until: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        'mute',
      );
      const before = (
        await sql('SELECT COUNT(*) AS n FROM `Notification` WHERE userId = ?', [member.id])
      )[0].n;
      await ok(
        api(owner.page, 'POST', `/api/channels/${channel.id}/messages`, {
          id: uuidv7(),
          content: 'muted <@everyone> hello',
        }),
        'muted mention',
      );
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(
        (await sql('SELECT COUNT(*) AS n FROM `Notification` WHERE userId = ?', [member.id]))[0].n,
        before,
        'nothing while muted',
      );
      // unmuted, with email for mentions: one mail once the member is away
      await ok(
        api(member.page, 'POST', '/api/notification-settings/mute', {
          scopeKind: 'channel',
          scopeId: channel.id,
          until: null,
        }),
        'unmute',
      );
      await ok(
        api(member.page, 'PUT', '/api/notification-settings', {
          scopeKind: 'channel',
          scopeId: channel.id,
          email: 'mentions',
        }),
        'email',
      );
      await member.page.goto(`${base}/app/t/${team.id}`);
      const since = Date.now() - 1000;
      await ok(
        api(owner.page, 'POST', `/api/channels/${channel.id}/messages`, {
          id: uuidv7(),
          content: `please read <@user:${member.id}>`,
        }),
        'mention for email',
      );
      const mail = await waitForMail(member.email, '#general', { since, timeoutMs: 45_000 });
      assert.match(mail, /please read/);

      // ---- 6. a team notebook co-edited by two people at once
      const notebook = randomUUID();
      await ok(
        api(owner.page, 'POST', '/api/notebooks', {
          id: notebook,
          spaceId: team.spaceId,
          name: 'Handbook',
          position: pos(),
        }),
        'notebook',
      );
      const tree = await ok(api(owner.page, 'GET', `/api/notebooks/${notebook}/tree`), 'tree');
      const page = randomUUID();
      await ok(
        api(owner.page, 'POST', '/api/pages', {
          id: page,
          categoryId: tree.categories[0].id,
          title: 'Welcome',
          position: pos(),
        }),
        'page',
      );
      await owner.page.goto(`${base}/app/p/${page}`);
      await member.page.goto(`${base}/app/p/${page}`);
      for (const who of [owner, member])
        await who.page.waitForSelector('.ProseMirror[contenteditable=true]');
      await owner.page.locator('.ProseMirror').click();
      await owner.page.keyboard.type('Written by Olivia.');
      await member.page.locator('.ProseMirror', { hasText: 'Written by Olivia.' }).waitFor();
      await member.page.locator('.ProseMirror').click();
      await member.page.keyboard.press('Control+End');
      await member.page.keyboard.type(' And by Max.');
      await owner.page.locator('.ProseMirror', { hasText: 'And by Max.' }).waitFor();
      await waitSaved(owner.page);
      await until(async () =>
        /And by Max/.test(
          (await sql('SELECT contentText FROM `Page` WHERE id = ?', [page]))[0].contentText,
        ),
      );

      // ---- 7. a board: a task moved with the keyboard
      const board = randomUUID();
      await ok(
        api(owner.page, 'POST', `/api/spaces/${team.spaceId}/boards`, {
          id: board,
          name: 'Plan',
          position: pos(),
        }),
        'board',
      );
      const detail = await ok(api(owner.page, 'GET', `/api/boards/${board}`), 'board detail');
      const cols = Object.fromEntries(detail.columns.map((c) => [c.kind, c.id]));
      const task = await ok(
        api(owner.page, 'POST', `/api/boards/${board}/tasks`, {
          id: randomUUID(),
          columnId: cols.todo,
          position: pos(),
          title: 'Write the launch post',
          assigneeIds: [member.id],
        }),
        'task',
      );
      await member.page.goto(`${base}/app/b/${board}`);
      const card = member.page.locator('article.card[data-task="Write the launch post"]');
      await card.focus();
      await member.page.keyboard.press('Alt+ArrowRight');
      await until(
        async () =>
          (await sql('SELECT columnId FROM `Task` WHERE id = ?', [task.id]))[0].columnId ===
          cols.doing,
      );

      // ---- 8. a meeting with an answer
      const start = new Date(Date.now() + 2 * 86_400_000);
      start.setUTCHours(9, 0, 0, 0);
      const meeting = await ok(
        api(owner.page, 'POST', '/api/events', {
          id: randomUUID(),
          spaceId: team.spaceId,
          title: 'Launch planning',
          kind: 'meeting',
          startAt: start.toISOString(),
          endAt: new Date(start.getTime() + 3_600_000).toISOString(),
          attendees: [{ kind: 'user', subjectId: member.id }],
        }),
        'meeting',
      );
      await member.page.goto(`${base}/app/calendar`);
      await member.page.getByText('Launch planning').first().waitFor();
      await ok(
        api(member.page, 'POST', `/api/events/${meeting.id}/rsvp`, { status: 'accepted' }),
        'rsvp',
      );
      const seen = await ok(api(owner.page, 'GET', `/api/events/${meeting.id}`), 'event detail');
      assert.ok(JSON.stringify(seen).includes('accepted'), 'the owner sees the answer');

      // ---- 9. the member's calendar feed, fetched the way a calendar app does (no login)
      const feed = await ok(api(member.page, 'POST', '/api/me/feeds', { name: 'Phone' }), 'feed');
      const ics = await (await fetch(feed.url.replace(/^https?:\/\/[^/]+/, base))).text();
      assert.match(ics, /BEGIN:VCALENDAR/);
      assert.match(ics, /SUMMARY:Launch planning/);

      // ---- 10. an offline edit that loses, put back from the Local history
      const offlineTask = await ok(
        api(owner.page, 'POST', `/api/boards/${board}/tasks`, {
          id: randomUUID(),
          columnId: cols.todo,
          position: pos(),
          title: 'Pick a date',
        }),
        'task for offline',
      );
      const open = async (who) => {
        await who.page.goto(`${base}/app/b/${board}`);
        await who.page.waitForSelector('[data-view=list]');
        await who.page.click('[data-view=list]');
        await who.page.locator('tr[data-task="Pick a date"]').waitFor();
        await who.page.waitForTimeout(1500);
      };
      await open(owner);
      await open(member);
      await member.ctx.setOffline(true);
      const titleMine = member.page.locator('tr[data-task="Pick a date"] [data-cell=title]');
      await titleMine.fill('Friday the 12th');
      await titleMine.press('Enter');
      await member.page.locator('tr[data-task="Friday the 12th"]').waitFor();
      const titleTheirs = owner.page.locator('tr[data-task="Pick a date"] [data-cell=title]');
      await titleTheirs.fill('Monday the 15th');
      await titleTheirs.press('Enter');
      await until(
        async () =>
          (await sql('SELECT title FROM `Task` WHERE id = ?', [offlineTask.id]))[0].title ===
          'Monday the 15th',
      );
      await goOnline(member);
      await member.page.waitForSelector('[data-history-button]', { timeout: 45_000 });
      await member.page.goto(`${base}/app/history`);
      const entry = member.page.locator('[data-entry][data-entity=task]').first();
      await entry.waitFor();
      assert.equal(
        (await entry.locator('[data-field=title] .mine').innerText()).trim(),
        'Friday the 12th',
      );
      await entry.locator('[data-act=replace]').click();
      await until(
        async () =>
          (await sql('SELECT title FROM `Task` WHERE id = ?', [offlineTask.id]))[0].title ===
          'Friday the 12th',
      );

      // ---- 11. a theme chosen on one device is there on the next
      await member.page.goto(`${base}/app/settings`);
      await member.page.click('.theme[data-pick="purple"]');
      await member.page.waitForFunction(
        () => document.documentElement.getAttribute('data-theme') === 'purple',
      );
      await until(
        async () =>
          (await sql('SELECT theme FROM `User` WHERE id = ?', [member.id]))[0].theme === 'purple',
      );
      const laptop = await device();
      await login(laptop.page, base, member.email);
      await laptop.page.waitForFunction(
        () => document.documentElement.getAttribute('data-theme') === 'purple',
      );

      for (const d of [admin, owner, member, laptop]) assert.deepEqual(d.problems, []);
      await Promise.all([admin.close(), owner.close(), member.close(), laptop.close()]);
    },
  );
});
