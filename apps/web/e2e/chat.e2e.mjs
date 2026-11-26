// End-to-end: chat channels. The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { launch, makePng, register, sql, startStack, uniqueEmail, verify } from './harness.mjs';

const T = { timeout: 300_000 };
const ADMIN_EMAIL = uniqueEmail('chatadmin');
const P = {
  MANAGE_MESSAGES: 1n << 15n,
  MANAGE_CHANNELS: 1n << 16n,
  ADD_REACTIONS: 1n << 11n,
  CREATE_THREADS: 1n << 12n,
  SEND_IN_THREADS: 1n << 13n,
  ATTACH_FILES: 1n << 10n,
  VIEW_CHANNEL: 1n << 7n,
};
const MODERATOR =
  P.MANAGE_MESSAGES | P.ADD_REACTIONS | P.CREATE_THREADS | P.SEND_IN_THREADS | P.ATTACH_FILES;

let stack;
let browser;
let base;
let adminOnce;

before(async () => {
  stack = await startStack({ env: { ADMIN_EMAILS: ADMIN_EMAIL } });
  base = stack.baseUrl;
  browser = await launch();
});
after(async () => {
  await (await adminOnce)?.close();
  await browser?.close();
  await stack?.stop();
});

async function device() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on(
    'console',
    (m) =>
      /Content Security Policy|violates the following/i.test(m.text()) &&
      problems.push(m.text().slice(0, 200)),
  );
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));
  return { ctx, page, problems, close: async () => ctx.close() };
}

async function account(name, wanted) {
  const d = await device();
  const { email } = await register(d.page, base, { name, ...(wanted ? { email: wanted } : {}) });
  await verify(d.page, email);
  await d.page.goto(`${base}/app`);
  await d.page.waitForSelector('app-rail');
  const id = (await sql('SELECT id FROM `User` WHERE email = ?', [email]))[0].id;
  return { ...d, email, id, name };
}

const getAdmin = () => (adminOnce ??= account('The Admin', ADMIN_EMAIL));

async function createTeam(admin, name, owner) {
  await admin.page.goto(`${base}/app/admin`);
  await admin.page.waitForSelector('[data-admin-teams]');
  await admin.page.fill('input[name=teamName]', name);
  await admin.page.fill('input[name=teamOwner]', owner.email);
  await admin.page.click('[data-create-team]');
  await admin.page.locator(`[data-team-row="${name}"]`).waitFor();
  return (await sql('SELECT id FROM `Team` WHERE name = ?', [name]))[0].id;
}

const joinTeam = (teamId, who) =>
  sql('INSERT INTO `TeamMember` (teamId, userId, joinedAt) VALUES (?, ?, NOW(3))', [
    teamId,
    who.id,
  ]);

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

async function answerPrompt(page, text) {
  const box = page.locator('mat-dialog-container input');
  await box.waitFor();
  await box.fill(text);
  await box.press('Enter');
  await page.waitForSelector('mat-dialog-container', { state: 'detached' });
}

/** The owner makes a channel through the sidebar; returns its id (read from the address). */
async function newChannel(owner, teamId, name) {
  await owner.page.goto(`${base}/app/t/${teamId}`);
  await owner.page.waitForSelector('[data-channel-list]');
  await owner.page.click('[data-action=new-channel-menu]');
  await owner.page.click('[data-action=new-channel]');
  await answerPrompt(owner.page, name);
  await owner.page.waitForURL(/\/app\/c\/[0-9a-f-]{36}$/);
  await owner.page.waitForSelector(`[data-channel-page][data-channel="${name}"]`);
  return owner.page.url().split('/').pop();
}

/** Sends a message through the composer. */
async function say(page, text) {
  const box = page.locator('[data-composer-input]');
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

const message = (page, text) => page.locator('[data-msg-id]', { hasText: text });

/** Hovers a message and clicks one of its actions. */
async function actOn(page, text, action, menu = false) {
  const m = message(page, text).first();
  await m.hover();
  if (menu) {
    await m.locator('[data-action=more]').click();
    await page.locator(`.mat-mdc-menu-panel [data-action=${action}]`).click();
  } else await m.locator(`[data-action=${action}]`).click();
}

/** A team with an owner who makes channels, and a member with the chat permissions of a moderator. */
async function setup(name) {
  const admin = await getAdmin();
  const owner = await account('Olga Owner');
  const bea = await account('Bea Member');
  const teamId = await createTeam(admin, name, owner);
  await joinTeam(teamId, bea);
  const role = await api(owner.page, 'POST', `/api/teams/${teamId}/roles`, {
    name: 'Moderator',
    permissions: MODERATOR.toString(),
  });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  assert.equal(
    (await api(owner.page, 'PUT', `/api/teams/${teamId}/members/${bea.id}/roles/${role.body.id}`))
      .status,
    204,
  );
  return { owner, bea, teamId };
}

describe('chat', () => {
  test(
    'two people in one channel: a message, an edit, a reaction, a reply, a pin and a thread all appear live; the unread badge of another channel clears when it is opened',
    T,
    async () => {
      const { owner, bea, teamId } = await setup('Live Chat Inc');
      const general = await newChannel(owner, teamId, 'general');
      const random = await newChannel(owner, teamId, 'random');

      // Bea is in #random; Olga writes in #general: Bea's sidebar shows it as unread, live.
      await bea.page.goto(`${base}/app/c/${random}`);
      await bea.page.waitForSelector('[data-channel-page][data-channel="random"]');
      await bea.page.waitForSelector('[data-channel-row="general"]');
      await owner.page.goto(`${base}/app/c/${general}`);
      await owner.page.waitForSelector('[data-channel-page][data-channel="general"]');
      await say(owner.page, 'Hello **Bea**');
      await message(owner.page, 'Hello Bea').first().waitFor();
      await bea.page.locator('[data-channel-row="general"] [data-unread-badge]').waitFor();
      assert.equal(
        (
          await bea.page.locator('[data-channel-row="general"] [data-unread-badge]').textContent()
        ).trim(),
        '1',
      );

      // Emphasis inside a word adds no spaces around it.
      await say(owner.page, 'x**y**z and a_b_c');
      await message(owner.page, 'and a_b_c').first().waitFor();
      assert.equal(
        (
          await message(owner.page, 'and a_b_c').first().locator('[data-text]').textContent()
        ).trim(),
        'xyz and a_b_c',
      );

      // Opening the channel shows the message (the bold text rendered as markdown) and clears the badge.
      await bea.page.click('[data-channel-row="general"] a.name');
      await bea.page.waitForSelector('[data-channel-page][data-channel="general"]');
      await message(bea.page, 'Hello Bea').first().waitFor();
      assert.equal(
        await message(bea.page, 'Hello Bea').first().locator('[data-text] strong').textContent(),
        'Bea',
      );
      await bea.page
        .locator('[data-channel-row="general"] [data-unread-badge]')
        .waitFor({ state: 'detached' });

      // Bea replies: Olga sees the reply with its preview, live.
      await actOn(bea.page, 'Hello Bea', 'reply');
      await bea.page.locator('[data-reply-banner]').waitFor();
      await say(bea.page, 'Hi Olga!');
      await message(owner.page, 'Hi Olga!').first().waitFor();
      assert.match(
        await message(owner.page, 'Hi Olga!').first().locator('[data-reply-preview]').textContent(),
        /Hello Bea/,
      );

      // Bea reacts with a thumbs-up: Olga sees the reaction on her message.
      const olgas = message(bea.page, 'Hello Bea').first();
      await olgas.hover();
      await olgas.locator('button.q', { hasText: '👍' }).click();
      await message(owner.page, 'Hello Bea').first().locator('[data-reaction="👍"]').waitFor();

      // Olga edits her message: Bea sees "(edited)" and the new text.
      await actOn(owner.page, 'Hello Bea', 'edit', true);
      await owner.page.locator('[data-edit-banner]').waitFor();
      await owner.page.locator('[data-composer-input]').fill('Hello Bea, welcome');
      await owner.page.locator('[data-composer-input]').press('Enter');
      await message(bea.page, 'welcome').first().locator('.edited').waitFor();

      // Bea pins Olga's message: it is in Olga's pinned list.
      await actOn(bea.page, 'welcome', 'pin', true);
      await message(owner.page, 'welcome').first().locator('.pin').waitFor(); // the pin reached Olga's page
      await owner.page.click('[data-action=pins]');
      await owner.page
        .locator('[data-side-panel][data-panel=pins] [data-msg-id]', { hasText: 'welcome' })
        .waitFor();
      await owner.page.click('[data-side-panel] [aria-label="Close"]');

      // A thread: Bea starts one on Olga's message and answers in it; Olga sees the thread under the message.
      await actOn(bea.page, 'welcome', 'thread');
      await answerPrompt(bea.page, 'Welcome chat');
      await bea.page.locator('[data-thread-panel]').waitFor();
      await bea.page.locator('[data-thread-panel] [data-composer-input]').fill('Thread reply');
      await bea.page.locator('[data-thread-panel] [data-composer-input]').press('Enter');
      await bea.page
        .locator('[data-thread-panel] [data-msg-id]', { hasText: 'Thread reply' })
        .waitFor();
      const chip = message(owner.page, 'welcome').first().locator('[data-thread-chip]');
      await chip.waitFor();
      assert.match(await chip.textContent(), /Welcome chat/);
      await owner.page.waitForFunction(() =>
        /1 replies/.test(document.querySelector('[data-thread-chip]')?.textContent ?? ''),
      );
      // ...and the reply does not appear in the channel's own list
      assert.equal(
        await owner.page
          .locator('[data-message-list] [data-msg-id]', { hasText: 'Thread reply' })
          .count(),
        0,
      );

      assert.deepEqual(
        [owner, bea].flatMap((d) => d.problems),
        [],
      );
      for (const d of [owner, bea]) await d.close();
    },
  );

  test(
    'offline: history stays readable, two messages are queued and then delivered once, in order',
    T,
    async () => {
      const { owner, bea, teamId } = await setup('Offline Chat Inc');
      const general = await newChannel(owner, teamId, 'general');
      await say(owner.page, 'earlier message');
      await message(owner.page, 'earlier message').first().waitFor();

      await bea.page.goto(`${base}/app/c/${general}`);
      await message(bea.page, 'earlier message').first().waitFor();
      // the history is saved on this device after it was shown
      await bea.page.waitForTimeout(800);

      await bea.ctx.setOffline(true);
      await bea.page.locator('[data-offline-banner]').waitFor();
      // leave the channel and come back while offline: what is read comes from this device
      await bea.page.click('[data-team-sidebar] a.title');
      await bea.page.waitForSelector('[data-team-page]');
      await bea.page.click('[data-channel-row="general"] a.name');
      await bea.page.waitForSelector('[data-channel-page][data-channel="general"]');
      await message(bea.page, 'earlier message').first().waitFor();

      await say(bea.page, 'queued one');
      await say(bea.page, 'queued two');
      await message(bea.page, 'queued one').first().locator('[data-sending]').waitFor();
      await message(bea.page, 'queued two').first().locator('[data-sending]').waitFor();
      assert.equal(
        (await sql('SELECT COUNT(*) AS n FROM `Message` WHERE content LIKE ?', ['queued%']))[0].n,
        0n,
        'nothing reached the server while offline',
      );

      await bea.ctx.setOffline(false);
      await message(bea.page, 'queued one')
        .first()
        .locator('[data-sending]')
        .waitFor({ state: 'detached', timeout: 30_000 });
      await message(bea.page, 'queued two')
        .first()
        .locator('[data-sending]')
        .waitFor({ state: 'detached', timeout: 30_000 });
      const rows = await sql(
        "SELECT content FROM `Message` WHERE content LIKE 'queued%' ORDER BY id",
      );
      assert.deepEqual(
        rows.map((r) => r.content),
        ['queued one', 'queued two'],
        'delivered once each, in the order written',
      );
      // and Olga received them live
      await message(owner.page, 'queued two').first().waitFor();
      for (const d of [owner, bea]) await d.close();
    },
  );

  test(
    'denying View channel for a member removes the channel from their sidebar at once and its address shows the not-found page',
    T,
    async () => {
      const { owner, bea, teamId } = await setup('Hidden Chat Inc');
      const general = await newChannel(owner, teamId, 'general');
      const staff = await newChannel(owner, teamId, 'staff');
      await bea.page.goto(`${base}/app/c/${staff}`);
      await bea.page.waitForSelector('[data-channel-page][data-channel="staff"]');
      await bea.page.waitForSelector('[data-channel-row="general"]');

      const denied = await api(owner.page, 'PUT', '/api/overwrites', {
        targetKind: 'channel',
        targetId: staff,
        subjectKind: 'member',
        subjectId: bea.id,
        allow: '0',
        deny: P.VIEW_CHANNEL.toString(),
      });
      assert.equal(denied.status, 200, JSON.stringify(denied.body));

      // no reload, no focus: the push does it
      await bea.page.locator('[data-channel-row="staff"]').waitFor({ state: 'detached' });
      await bea.page.locator('app-not-found').waitFor();
      assert.equal(
        await bea.page.locator('[data-channel-row="general"]').count(),
        1,
        'the other channel is still there',
      );
      await bea.page.goto(`${base}/app/c/${staff}`);
      await bea.page.locator('app-not-found').waitFor();
      assert.equal((await api(bea.page, 'GET', `/api/channels/${staff}/messages`)).status, 404);
      void general;
      for (const d of [owner, bea]) await d.close();
    },
  );

  test(
    'pasting an image sends it as an attachment shown inline; clicking opens the lightbox; the file counts in the team’s usage',
    T,
    async () => {
      const { owner, bea, teamId } = await setup('Pictures Chat Inc');
      const general = await newChannel(owner, teamId, 'general');
      await bea.page.goto(`${base}/app/c/${general}`);
      await bea.page.waitForSelector('[data-channel-page][data-channel="general"]');

      const png = (await makePng(160, 120)).toString('base64');
      const box = bea.page.locator('[data-composer-input]');
      await box.click();
      await bea.page.evaluate(async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const data = new DataTransfer();
        data.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
        document
          .querySelector('[data-composer-input]')
          .dispatchEvent(
            new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
          );
      }, png);
      await bea.page.locator('[data-upload=done]').waitFor();
      await box.fill('look at this');
      await box.press('Enter');

      // inline for her, and live for Olga
      for (const who of [bea, owner]) {
        if (who === owner) await owner.page.goto(`${base}/app/c/${general}`);
        const pic = message(who.page, 'look at this')
          .first()
          .locator('[data-attachment="screenshot.png"] img');
        await pic.waitFor();
        await who.page.waitForFunction(() =>
          [...document.querySelectorAll('[data-attachment] img')].every(
            (i) => i.complete && i.naturalWidth > 0,
          ),
        );
      }

      await message(bea.page, 'look at this')
        .first()
        .locator('[data-attachment="screenshot.png"]')
        .click();
      await bea.page.locator('[data-lightbox] img').waitFor();
      await bea.page.keyboard.press('Escape');
      await bea.page.locator('[data-lightbox]').waitFor({ state: 'detached' });

      const [space] = await sql('SELECT storageUsedBytes FROM `Space` WHERE teamId = ?', [teamId]);
      const size = Number(
        (
          await sql(
            'SELECT size FROM `Media` WHERE spaceId = (SELECT id FROM `Space` WHERE teamId = ?)',
            [teamId],
          )
        )[0].size,
      );
      assert.equal(
        Number(space.storageUsedBytes),
        size + Buffer.byteLength('look at this'),
        'the team space is charged for the picture and the text',
      );
      assert.equal(
        Number(
          (await sql('SELECT storageUsedBytes FROM `Space` WHERE userId = ?', [bea.id]))[0]
            .storageUsedBytes,
        ),
        0,
        'her own storage is untouched',
      );
      assert.deepEqual(
        [owner, bea].flatMap((d) => d.problems),
        [],
      );
      for (const d of [owner, bea]) await d.close();
    },
  );
});
