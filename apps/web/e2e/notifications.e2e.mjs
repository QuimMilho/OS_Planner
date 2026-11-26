// End-to-end: mentions, the inbox, mute, email and Web Push. The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  MAILPIT,
  launch,
  register,
  sql,
  startStack,
  uniqueEmail,
  verify,
  waitForMail,
  waitForOfflineReady,
} from './harness.mjs';

const T = { timeout: 300_000 };
const ADMIN_EMAIL = uniqueEmail('notifyadmin');
const requireFromServer = createRequire(resolve(import.meta.dirname, '../../server/package.json'));

let stack;
let browser;
let base;
let adminOnce;
let pushServer;
/** Every push the fake push service received: the path and the raw (encrypted) body. */
const pushes = [];

before(async () => {
  pushServer = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      pushes.push({ path: req.url, body: Buffer.concat(chunks) });
      res.statusCode = 201;
      res.end();
    });
  });
  await new Promise((r) => pushServer.listen(0, '127.0.0.1', r));
  const pushOrigin = `http://127.0.0.1:${pushServer.address().port}`;
  const vapid = requireFromServer('web-push').generateVAPIDKeys();
  stack = await startStack({
    env: {
      ADMIN_EMAILS: ADMIN_EMAIL,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      VAPID_SUBJECT: 'mailto:e2e@example.com',
      PUSH_EXTRA_ENDPOINTS: pushOrigin,
      NOTIFY_PUSH_COALESCE_SECONDS: '0',
      NOTIFY_AWAY_SECONDS: '3',
      NOTIFY_SWEEP_SECONDS: '2',
    },
  });
  base = stack.baseUrl;
  browser = await launch();
});
after(async () => {
  await (await adminOnce)?.close();
  await browser?.close();
  await stack?.stop();
  await new Promise((r) => pushServer?.close(r));
});

async function device(extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, ...extra });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  if (process.env.E2E_DEBUG) {
    page.on('pageerror', (e) => console.error('pageerror:', e.message));
    page.on(
      'console',
      (m) => m.type() === 'error' && console.error('console:', m.text().slice(0, 300)),
    );
    page.on('response', (r) => r.status() >= 400 && console.error('http', r.status(), r.url()));
  }
  return { ctx, page, close: async () => ctx.close() };
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

/** A team with an owner, a writer (Wendy), and three readers; a channel; and a mentionable role "Testers" held by Rita. */
async function setup(name, { redact = false } = {}) {
  const admin = await getAdmin();
  const owner = await account('Olga Owner');
  const wendy = await account('Wendy Writer');
  const bob = await account('Bob Reader');
  const rita = await account('Rita Role');
  const dan = await account('Dan Outside');
  const teamId = await createTeam(admin, name, owner);
  for (const m of [wendy, bob, rita, dan]) await joinTeam(teamId, m);
  const spaceId = (await sql('SELECT spaceId FROM `Team` WHERE id = ?', [teamId]))[0].spaceId;
  const channel = await api(owner.page, 'POST', `/api/spaces/${spaceId}/channels`, {
    name: 'general',
    redactPreviews: redact,
  });
  assert.equal(channel.status, 201, JSON.stringify(channel.body));
  const role = await api(owner.page, 'POST', `/api/teams/${teamId}/roles`, {
    name: 'Testers',
    permissions: '0',
    mentionable: true,
  });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  assert.equal(
    (await api(owner.page, 'PUT', `/api/teams/${teamId}/members/${rita.id}/roles/${role.body.id}`))
      .status,
    204,
  );
  return { owner, wendy, bob, rita, dan, teamId, channelId: channel.body.id, roleId: role.body.id };
}

async function openChannel(who, channelId) {
  await who.page.goto(`${base}/app/c/${channelId}`);
  await who.page.waitForSelector('[data-channel-page]');
}

async function say(page, text) {
  const box = page.locator('[data-composer-input]');
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

/** Types a message with mentions picked from the `@` list: `parts` mixes plain strings and { pick: "@Name" }. */
async function sayWithMentions(page, parts) {
  const box = page.locator('[data-composer-input]');
  await box.click();
  await box.fill('');
  for (const part of parts) {
    if (typeof part === 'string') await box.pressSequentially(part);
    else {
      await box.pressSequentially(part.type ?? '@');
      await page.locator(`[data-mention-option="${part.pick}"]`).click();
    }
  }
  await box.press('Enter');
}

const message = (page, text) => page.locator('[data-msg-id]', { hasText: text });
const bell = (page) => page.locator('[data-bell-badge]');
const bellCount = async (page) =>
  (await bell(page).count()) ? Number((await bell(page).textContent()).trim()) : 0;

async function waitBell(page, n) {
  await page.waitForFunction(
    ([expected]) => {
      const el = document.querySelector('[data-bell-badge]');
      return (el ? Number(el.textContent.trim()) : 0) === expected;
    },
    [n],
  );
}

describe('mentions and notifications', () => {
  test(
    'A mentions B and the role R: the bell of B rises live, the channel is highlighted and opening it clears it; someone in R gets it, someone outside does not',
    T,
    async () => {
      const { owner, wendy, bob, rita, dan, teamId, channelId } = await setup('Mention Team');
      // B and the others are elsewhere in the team; Wendy writes in the channel.
      for (const who of [bob, rita, dan]) {
        await who.page.goto(`${base}/app/t/${teamId}`);
        await who.page.waitForSelector('[data-channel-list]');
      }
      await openChannel(wendy, channelId);
      await sayWithMentions(wendy.page, [
        'hello ',
        { pick: '@Bob Reader' },
        ' and ',
        { type: '@Test', pick: '@Testers' },
        ' please look',
      ]);
      await message(wendy.page, 'please look').first().waitFor();
      await message(wendy.page, 'please look').first().locator('[data-mention]').nth(1).waitFor(); // the server's version of the message has its chips
      assert.equal(
        await message(wendy.page, 'please look').first().locator('[data-mention]').count(),
        2,
      );

      // Bob: the bell shows 1 at once, the channel row is highlighted with a mention badge.
      await waitBell(bob.page, 1);
      await bob.page.locator('[data-channel-row="general"] [data-mention-badge]').waitFor();
      // The role: Rita is told, Dan is not.
      await waitBell(rita.page, 1);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(await bellCount(dan.page), 0);
      assert.equal(
        await dan.page.locator('[data-channel-row="general"] [data-mention-badge]').count(),
        0,
      );

      // The inbox lists it; opening the channel clears the badge and the notification.
      await bob.page.click('[data-bell]');
      const item = bob.page.locator('[data-inbox] [data-notification]');
      await item.waitFor();
      assert.equal(await item.getAttribute('data-notification'), 'mention_user');
      assert.match(await item.textContent(), /please look/);
      await bob.page.keyboard.press('Escape');
      await bob.page
        .locator('[data-inbox]')
        .waitFor({ state: 'detached' })
        .catch(() => undefined);
      await bob.page.goto(`${base}/app/c/${channelId}`);
      await bob.page.waitForSelector('[data-channel-page]');
      await message(bob.page, 'please look').first().waitFor();
      assert.ok(
        (await message(bob.page, 'please look').first().getAttribute('data-mentioned')) !== null,
        'the message that mentions Bob is highlighted',
      );
      await waitBell(bob.page, 0);
      await bob.page
        .locator('[data-channel-row="general"] [data-mention-badge]')
        .waitFor({ state: 'detached' });
      assert.equal(await bellCount(rita.page), 1);

      // A mention of somebody who cannot see the channel warns the author instead of notifying them.
      const hide = await api(owner.page, 'PUT', '/api/overwrites', {
        targetKind: 'channel',
        targetId: channelId,
        subjectKind: 'member',
        subjectId: dan.id,
        allow: '0',
        deny: String(1n << 7n),
      });
      assert.equal(hide.status, 200, JSON.stringify(hide.body));
      await wendy.page.reload();
      await wendy.page.waitForSelector('[data-channel-page]');
      await sayWithMentions(wendy.page, [
        'psst ',
        { type: '@Dan', pick: '@Dan Outside' },
        ' hello',
      ]);
      await wendy.page
        .locator('.mat-mdc-snack-bar-container', { hasText: 'cannot see this channel' })
        .waitFor();
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(await bellCount(dan.page), 0);
      await Promise.all([wendy.close(), bob.close(), rita.close(), dan.close(), owner.close()]);
    },
  );

  test(
    'B mutes the channel for an hour: ordinary role mentions stop, a direct mention still arrives until "suppress direct" is on, and unmuting brings it all back',
    T,
    async () => {
      const { owner, wendy, bob, rita, teamId, channelId, roleId } = await setup('Mute Team');
      // Bob holds the role too, so a role mention would reach him.
      assert.equal(
        (await api(owner.page, 'PUT', `/api/teams/${teamId}/members/${bob.id}/roles/${roleId}`))
          .status,
        204,
      );
      await openChannel(wendy, channelId);
      await bob.page.goto(`${base}/app/t/${teamId}`);
      await bob.page.waitForSelector('[data-channel-list]');
      await openChannel(rita, channelId); // somebody else in the channel, to prove the page keeps working
      await bob.page.goto(`${base}/app/c/${channelId}`);
      await bob.page.waitForSelector('[data-channel-page]');

      // Mute for 1 hour from the channel's bell button.
      await bob.page.click('[data-action=notifications]');
      await bob.page.locator('[data-notify-dialog]').waitFor();
      await bob.page.click('[data-mute="60"]');
      await bob.page.locator('[data-muted]').waitFor();
      await bob.page.keyboard.press('Escape');
      await bob.page.goto(`${base}/app/t/${teamId}`); // leave the channel so what arrives counts
      await bob.page.waitForSelector('[data-channel-list]');

      // A role mention (silenced) then a mention by name (not silenced).
      await sayWithMentions(wendy.page, ['role ', { pick: '@Testers' }, ' only']);
      await message(wendy.page, 'only').first().waitFor();
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(await bellCount(bob.page), 0);
      await sayWithMentions(wendy.page, ['named ', { pick: '@Bob Reader' }, ' now']);
      await message(wendy.page, 'now').first().waitFor();
      await waitBell(bob.page, 1);

      // "Suppress direct" silences even that.
      await bob.page.goto(`${base}/app/c/${channelId}`);
      await bob.page.waitForSelector('[data-channel-page]');
      await bob.page.click('[data-action=notifications]');
      await bob.page.locator('[data-notify-dialog]').waitFor();
      await bob.page.check('[data-suppress=direct]');
      await bob.page.locator('[data-effective]').waitFor();
      await bob.page.keyboard.press('Escape');
      await bob.page.goto(`${base}/app/t/${teamId}`);
      await bob.page.waitForSelector('[data-channel-list]');
      // (opening the channel may already have read it: read everything either way)
      assert.equal(
        (await api(bob.page, 'POST', '/api/notifications/read', { all: true })).status,
        204,
      );
      await bob.page.reload();
      await bob.page.waitForSelector('[data-channel-list]');
      await waitBell(bob.page, 0);
      await sayWithMentions(wendy.page, ['again ', { pick: '@Bob Reader' }, ' quietly']);
      await message(wendy.page, 'quietly').first().waitFor();
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(await bellCount(bob.page), 0);

      // Unmute (and let direct mentions through again): a role mention reaches him again.
      await bob.page.goto(`${base}/app/c/${channelId}`);
      await bob.page.waitForSelector('[data-channel-page]');
      await bob.page.click('[data-action=notifications]');
      await bob.page.locator('[data-notify-dialog]').waitFor();
      await bob.page.click('[data-unmute]');
      await bob.page.locator('[data-muted]').waitFor({ state: 'detached' });
      await bob.page.uncheck('[data-suppress=direct]');
      await bob.page.keyboard.press('Escape');
      await bob.page.goto(`${base}/app/t/${teamId}`);
      await bob.page.waitForSelector('[data-channel-list]');
      await sayWithMentions(wendy.page, ['role again ', { pick: '@Testers' }, ' back']);
      await message(wendy.page, 'back').first().waitFor();
      await waitBell(bob.page, 1);

      await Promise.all([wendy.close(), bob.close(), rita.close(), owner.close()]);
    },
  );

  test(
    'email "mentions" on a channel: exactly one mail arrives once B is idle, in B\'s language, and its link switches the option off without a login',
    T,
    async () => {
      const { wendy, bob, teamId, channelId } = await setup('Mail Team');
      assert.equal((await api(bob.page, 'PATCH', '/api/me', { locale: 'pt' })).status, 200);
      await bob.page.goto(`${base}/app/t/${teamId}`);
      await bob.page.waitForSelector('[data-channel-list]');
      await bob.page.goto(`${base}/app/c/${channelId}`);
      await bob.page.waitForSelector('[data-channel-page]');
      const since = Date.now() - 1000;
      await bob.page.click('[data-action=notifications]');
      await bob.page.locator('[data-notify-dialog]').waitFor();
      await bob.page.selectOption('[data-email]', 'mentions');
      await bob.page
        .locator('[data-eff=email]')
        .filter({ hasText: /Só menções|Mentions only/ })
        .waitFor();
      await bob.page.keyboard.press('Escape');
      await bob.page.goto(`${base}/app/t/${teamId}`);

      await openChannel(wendy, channelId);
      await say(wendy.page, 'no mention, no mail');
      await sayWithMentions(wendy.page, ['mail me ', { pick: '@Bob Reader' }, ' please']);
      await message(wendy.page, 'please').first().waitFor();

      // Bob's page is open but nobody touches it: after a few seconds he counts as away and one mail goes out.
      const text = await waitForMail(bob.email, 'Nova mensagem em #general', {
        since,
        timeoutMs: 40_000,
      });
      assert.match(text, /Olá Bob Reader/);
      assert.match(text, /mail me/);
      assert.ok(!/no mention, no mail/.test(text));
      await new Promise((r) => setTimeout(r, 7000));
      const found = await (
        await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${bob.email}`)}`)
      ).json();
      assert.equal(
        found.messages.filter((m) => /#general/.test(m.Subject)).length,
        1,
        'exactly one mail',
      );

      // The unsubscribe link works in a browser that is not signed in.
      const link = text.match(/https?:\/\/\S+\/mail\/action\?token=\S+/g).find((l) => true);
      const anon = await device();
      const unsub = text
        .split('\n')
        .find((l) => /Deixar de receber email/.test(l))
        .match(/https?:\/\/\S+/)[0];
      assert.ok(link && unsub);
      await anon.page.goto(unsub);
      await anon.page.locator('[data-mail-action]').waitFor();
      await anon.page
        .locator('[data-mail-action] h1', {
          hasText: /Deixará de receber email|You will not get email/,
        })
        .waitFor();
      assert.equal(
        (
          await sql(
            "SELECT email FROM `NotificationSetting` WHERE userId = ? AND scopeKind = 'channel' AND scopeId = ?",
            [bob.id, channelId],
          )
        )[0].email,
        'off',
      );
      await anon.close();
      await Promise.all([wendy.close(), bob.close()]);
    },
  );

  test(
    'Web Push: subscribing registers an endpoint, a message triggers a push to the fake push service that carries the link, and a channel that hides previews carries no text',
    T,
    async () => {
      const { wendy, bob, channelId, owner } = await setup('Push Team');
      // A device the way a browser makes one: a P-256 key and a secret. Chrome's own push service is not reachable here, so
      // the page's PushManager is replaced by one that hands out this subscription (the server's side is all real).
      const keys = createECDH('prime256v1');
      keys.generateKeys();
      const auth = randomBytes(16);
      const sub = {
        endpoint: `http://127.0.0.1:${pushServer.address().port}/push/${randomBytes(6).toString('hex')}`,
        p256dh: keys.getPublicKey().toString('base64url'),
        auth: auth.toString('base64url'),
      };
      await bob.ctx.grantPermissions(['notifications'], { origin: base });
      await bob.page.addInitScript((s) => {
        // like a real registration, the subscription outlives page loads (kept in sessionStorage here)
        const fake = {
          endpoint: s.endpoint,
          expirationTime: null,
          toJSON: () => ({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }),
          unsubscribe: async () => (sessionStorage.removeItem('fakeSub'), true),
        };
        PushManager.prototype.subscribe = async () => (
          sessionStorage.setItem('fakeSub', '1'),
          fake
        );
        PushManager.prototype.getSubscription = async () =>
          sessionStorage.getItem('fakeSub') ? fake : null;
      }, sub);

      await bob.page.goto(`${base}/app/settings`);
      await waitForOfflineReady(bob.page);
      await bob.page.click('[data-action=push-enable]');
      await bob.page.locator('[data-push-state=on]').waitFor();
      assert.equal(
        (await sql('SELECT COUNT(*) AS n FROM `PushSubscription` WHERE userId = ?', [bob.id]))[0].n,
        1n,
      );
      await bob.page.locator('[data-push-devices] li button').first().waitFor();

      // Bob is elsewhere; a mention triggers a push to his device.
      await bob.page.goto(`${base}/app`);
      await openChannel(wendy, channelId);
      await sayWithMentions(wendy.page, ['push ', { pick: '@Bob Reader' }, ' this']);
      await message(wendy.page, 'this').first().waitFor();
      for (let i = 0; i < 40 && !pushes.length; i++) await new Promise((r) => setTimeout(r, 250));
      assert.ok(pushes.length >= 1, 'a push reached the fake push service');
      const open = decryptPush(pushes.at(-1).body, keys, auth);
      assert.equal(open.notification.title.startsWith('#general'), true);
      assert.match(open.notification.body, /Wendy Writer: push .* this/);
      assert.match(open.notification.data.url, new RegExp(`/app/c/${channelId}$`));
      assert.deepEqual(open.notification.data.onActionClick.default, {
        operation: 'navigateLastFocusedOrOpen',
        url: open.notification.data.url,
      });
      assert.ok(pushes.at(-1).path.startsWith('/push/'));

      // A channel that hides previews: the push says what happened, never what was said.
      assert.equal(
        (await api(owner.page, 'PATCH', `/api/channels/${channelId}`, { redactPreviews: true }))
          .status,
        200,
      );
      const before = pushes.length;
      await sayWithMentions(wendy.page, ['top secret ', { pick: '@Bob Reader' }, ' words']);
      await message(wendy.page, 'words').first().waitFor();
      for (let i = 0; i < 40 && pushes.length === before; i++)
        await new Promise((r) => setTimeout(r, 250));
      assert.ok(pushes.length > before);
      const hidden = JSON.stringify(decryptPush(pushes.at(-1).body, keys, auth));
      assert.ok(!/secret|words/.test(hidden), hidden);
      assert.match(hidden, /mentioned you/);

      // Turning it off for this device removes the endpoint.
      await bob.page.goto(`${base}/app/settings`);
      await bob.page.click('[data-action=push-disable]');
      await bob.page.locator('[data-action=push-enable]').waitFor();
      assert.equal(
        (await sql('SELECT COUNT(*) AS n FROM `PushSubscription` WHERE userId = ?', [bob.id]))[0].n,
        0n,
      );
      await Promise.all([wendy.close(), bob.close(), owner.close()]);
    },
  );
});

/** Decrypts a Web Push body (RFC 8291, aes128gcm) with the device's key and secret. */
function decryptPush(body, ecdh, auth) {
  const salt = body.subarray(0, 16);
  const idLength = body[20];
  const serverPublic = body.subarray(21, 21 + idLength);
  const data = body.subarray(21 + idLength);
  const secret = ecdh.computeSecret(serverPublic);
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    ecdh.getPublicKey(),
    serverPublic,
  ]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, keyInfo, 32));
  const key = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([
    decipher.update(data.subarray(0, data.length - 16)),
    decipher.final(),
  ]);
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0) end--;
  return JSON.parse(plain.subarray(0, end - 1).toString('utf8')); // the last byte is the 0x02 delimiter
}
