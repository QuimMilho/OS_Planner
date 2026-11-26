// End-to-end: direct messages. The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { launch, register, sql, startStack, uniqueEmail, verify } from './harness.mjs';

const T = { timeout: 300_000 };
const ADMIN_EMAIL = uniqueEmail('dmadmin');

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

async function say(page, text) {
  const box = page.locator('[data-composer-input]');
  await box.click();
  await box.fill(text);
  await box.press('Enter');
}

const message = (page, text) => page.locator('[data-msg-id]', { hasText: text });

describe('direct messages', () => {
  test(
    "A messages B from the member list; B sees the unread badge and replies; both see it live; B blocks A and A's next message is refused without saying why",
    T,
    async () => {
      const admin = await getAdmin();
      const owner = await account('Olga Owner');
      const alice = await account('Alice Writer');
      const bob = await account('Bob Reader');
      const teamId = await createTeam(admin, 'Direct Team', owner);
      await joinTeam(teamId, alice);
      await joinTeam(teamId, bob);

      // Alice opens the member list and clicks "Message" on Bob.
      await alice.page.goto(`${base}/app/t/${teamId}/settings`);
      await alice.page.waitForSelector('[data-members-tab]');
      await alice.page.locator(`[data-member-id="${bob.id}"] [data-action=message-member]`).click();
      await alice.page.waitForURL(/\/app\/dm\/[0-9a-f-]{36}$/);
      await alice.page.waitForSelector('[data-channel-page] [data-dm-name]');
      assert.equal((await alice.page.locator('[data-dm-name]').textContent()).trim(), 'Bob Reader');
      const dmId = alice.page.url().split('/').pop();

      // Bob is somewhere else in the app: the rail shows a badge once Alice writes.
      await bob.page.goto(`${base}/app`);
      await bob.page.waitForSelector('app-rail');
      await say(alice.page, 'hello bob');
      await message(alice.page, 'hello bob').first().waitFor();
      await bob.page.locator('[data-rail-badge=dms]').waitFor();
      assert.equal((await bob.page.locator('[data-rail-badge=dms]').textContent()).trim(), '1');

      // He opens the conversation from the rail: the list shows it with a badge, opening it clears both.
      await bob.page.click('[data-rail=dms]');
      await bob.page.waitForSelector('[data-dm-sidebar]');
      const row = bob.page.locator('[data-dm="Alice Writer"]');
      await row.locator('[data-dm-badge]').waitFor();
      await row.click();
      await message(bob.page, 'hello bob').first().waitFor();
      await bob.page.locator('[data-rail-badge=dms]').waitFor({ state: 'detached' });

      // His reply reaches Alice at once, without a reload.
      await say(bob.page, 'hi alice');
      await message(alice.page, 'hi alice').first().waitFor();

      // A reaction and a pin work in a conversation too (either person pins).
      const mine = message(alice.page, 'hi alice').first();
      await mine.hover();
      await mine.locator('[data-action=more]').click();
      await alice.page.locator('.mat-mdc-menu-panel [data-action=pin]').click();
      await alice.page.locator('[data-action=pins]').click();
      await alice.page
        .locator('[data-side-panel] [data-msg-id]', { hasText: 'hi alice' })
        .waitFor();

      // Bob blocks Alice from the conversation menu.
      await bob.page.click('[data-action=dm-menu]');
      await bob.page.click('.mat-mdc-menu-panel [data-action=dm-block]');
      await bob.page.locator('mat-dialog-container button', { hasText: /^Block$/ }).click();
      await bob.page.locator('[data-dm-blocked]').waitFor();

      // Alice's next message is refused with the one neutral text.
      await say(alice.page, 'are you there?');
      const failed = alice.page
        .locator('[data-msg-id]', { hasText: 'are you there?' })
        .locator('[data-failed]');
      await failed.waitFor();
      assert.match(await failed.locator('[data-failed-reason]').textContent(), /cannot be sent/);
      // The history is still readable, and the server holds three sendings but not the refused one.
      assert.equal(
        (
          await sql(
            "SELECT COUNT(*) AS n FROM `Message` m JOIN `Channel` c ON c.id = m.channelId WHERE c.kind = 'dm'",
          )
        )[0].n,
        2n,
      );

      // Bob can unblock from Settings → Privacy, and the conversation works again.
      await bob.page.goto(`${base}/app/settings`);
      await bob.page.locator('[data-blocked="Alice Writer"] [data-action=unblock]').click();
      await bob.page.locator('[data-blocked-none]').waitFor();
      await alice.page
        .locator('[data-msg-id]', { hasText: 'are you there?' })
        .locator('[data-action=retry], button', { hasText: 'Retry' })
        .first()
        .click();
      await bob.page.goto(`${base}/app/dm/${dmId}`);
      await message(bob.page, 'are you there?').first().waitFor();

      await Promise.all([owner.close(), alice.close(), bob.close()]);
    },
  );

  test(
    "somebody with no team in common cannot find A in the picker, and the direct address of A's conversation is the not-found page",
    T,
    async () => {
      const admin = await getAdmin();
      const owner = await account('Pia Owner');
      const alice = await account('Ana Findable');
      const bob = await account('Ben Partner');
      const carl = await account('Carl Outsider');
      const teamId = await createTeam(admin, 'Private Duo', owner);
      await joinTeam(teamId, alice);
      await joinTeam(teamId, bob);
      const otherTeam = await createTeam(admin, 'Elsewhere', carl);
      assert.ok(otherTeam);

      const started = await alice.page.evaluate(async (bobId) => {
        const refresh = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'X-Requested-With': 'os_planner' },
        });
        const { accessToken } = await refresh.json();
        const res = await fetch('/api/dms', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: bobId }),
        });
        return res.json();
      }, bob.id);

      // Carl: the picker lists nobody called Ana, and the address of the conversation is a 404 page.
      await carl.page.goto(`${base}/app/dm`);
      await carl.page.waitForSelector('[data-dm-picker]');
      await carl.page.fill('[data-dm-search]', 'Ana');
      await carl.page.locator('[data-dm-none]').waitFor();
      assert.equal(await carl.page.locator('[data-dm-person]').count(), 0);
      await carl.page.goto(`${base}/app/dm/${started.id}`);
      await carl.page.locator('app-not-found').waitFor();
      // Neither does the channel address reveal it.
      await carl.page.goto(`${base}/app/c/${started.channelId}`);
      await carl.page.locator('app-not-found').waitFor();
      // Alice (a participant) sees the person she may write to, and the owner of her team is offered to her too.
      await alice.page.goto(`${base}/app/dm`);
      await alice.page.fill('[data-dm-search]', 'Pia');
      await alice.page.locator('[data-dm-person="Pia Owner"]').waitFor();

      await Promise.all([owner.close(), alice.close(), bob.close(), carl.close()]);
    },
  );

  test(
    'closing a conversation hides it from the list; a new message from the other side brings it back with an unread badge',
    T,
    async () => {
      const admin = await getAdmin();
      const owner = await account('Ola Owner');
      const alice = await account('Anne Closer');
      const bob = await account('Bert Sender');
      const teamId = await createTeam(admin, 'Closers', owner);
      await joinTeam(teamId, alice);
      await joinTeam(teamId, bob);

      await bob.page.goto(`${base}/app/dm`);
      await bob.page.fill('[data-dm-search]', 'Anne');
      await bob.page.locator('[data-dm-person="Anne Closer"]').click();
      await bob.page.waitForURL(/\/app\/dm\/[0-9a-f-]{36}$/);
      await say(bob.page, 'first');
      await message(bob.page, 'first').first().waitFor();

      await alice.page.goto(`${base}/app/dm`);
      await alice.page.locator('[data-dm="Bert Sender"]').click();
      await message(alice.page, 'first').first().waitFor();

      // Alice closes it: gone from her list (not Bert's).
      await alice.page.click('[data-action=dm-menu]');
      await alice.page.click('.mat-mdc-menu-panel [data-action=dm-close]');
      await alice.page.waitForURL(/\/app\/dm$/);
      await alice.page.locator('[data-dm-empty]').waitFor();
      assert.equal(await alice.page.locator('[data-dm="Bert Sender"]').count(), 0);
      assert.equal(await bob.page.locator('[data-dm="Anne Closer"]').count(), 1);

      // Bert writes again: it comes back for Alice, unread, without a reload.
      await say(bob.page, 'second');
      const back = alice.page.locator('[data-dm="Bert Sender"]');
      await back.waitFor();
      await back.locator('[data-dm-badge]').waitFor();
      assert.equal((await back.locator('[data-dm-badge]').textContent()).trim(), '1');

      await Promise.all([owner.close(), alice.close(), bob.close()]);
    },
  );
});
