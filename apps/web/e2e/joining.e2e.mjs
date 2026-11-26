// End-to-end: joining teams (invitations by email and by link, the public directory, requests, leaving and removing).
// The real app in real Chrome against the real server, with real mail (Mailpit).
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  launch,
  linkIn,
  register,
  sql,
  startStack,
  uniqueEmail,
  verify,
  waitForMail,
  PASSWORD,
} from './harness.mjs';

const T = { timeout: 300_000 };
const ADMIN_EMAIL = uniqueEmail('admin');
const EDIT_PAGES = '524288';

let stack;
let browser;
let base;
let admin;

before(async () => {
  stack = await startStack({ env: { ADMIN_EMAILS: ADMIN_EMAIL } });
  base = stack.baseUrl;
  browser = await launch();
  admin = await account('The Admin', ADMIN_EMAIL);
});
after(async () => {
  await browser?.close();
  await stack?.stop();
});

async function device() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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

/** A verified account on its own device. */
async function account(name, wanted) {
  const d = await device();
  const { email } = await register(d.page, base, { name, ...(wanted ? { email: wanted } : {}) });
  await verify(d.page, email);
  await d.page.goto(`${base}/app`);
  await d.page.waitForSelector('app-rail');
  return { ...d, email, name };
}

/** Calls the API as the signed-in person (from inside their page, so the session cookie applies). */
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
    [method, path, body],
  );
}

/** The administrator creates a team naming `owner` as its owner; returns its id. */
async function makeTeam(name, ownerEmail) {
  await admin.page.goto(`${base}/app/admin`);
  await admin.page.waitForSelector('[data-admin-teams]');
  await admin.page.fill('input[name=teamName]', name);
  await admin.page.fill('input[name=teamOwner]', ownerEmail);
  await admin.page.click('[data-create-team]');
  await admin.page.locator(`[data-team-row="${name}"]`).waitFor();
  return (await sql('SELECT id FROM `Team` WHERE name = ?', [name]))[0].id;
}

const settings = async (page, teamId, tab) => {
  await page.goto(`${base}/app/t/${teamId}/settings?tab=${tab}`);
  await page.waitForSelector(`[data-team-settings] [data-tab="${tab}"][aria-selected="true"]`);
};

/** Types into the name dialog and confirms it. */
async function answerPrompt(page, text) {
  const box = page.locator('mat-dialog-container input');
  await box.waitFor();
  await box.fill(text);
  await box.press('Enter');
  await page.waitForSelector('mat-dialog-container', { state: 'detached' });
}

/** Confirms a yes/no dialog. */
async function confirmDialog(page) {
  await page.locator('mat-dialog-container mat-dialog-actions button').last().click();
  await page.waitForSelector('mat-dialog-container', { state: 'detached' });
}

/** The teams this device still holds in its local database. */
const localTeams = (page, userId) =>
  page.evaluate(
    (name) =>
      new Promise((resolve) => {
        const open = indexedDB.open(name);
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('teams')) return resolve(null);
          const all = db.transaction('teams').objectStore('teams').getAll();
          all.onsuccess = () => resolve(all.result.map((t) => t.name));
        };
      }),
    `os_planner-${userId}`,
  );

const userId = async (email) => (await sql('SELECT id FROM `User` WHERE email = ?', [email]))[0].id;

/** A link invitation made through the API; returns its token. */
async function linkToken(owner, teamId, extra = {}) {
  const res = await api(owner.page, 'POST', `/api/teams/${teamId}/invites`, {
    link: true,
    ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.url.split('/invite/')[1];
}

describe('joining teams', () => {
  test(
    'an email invitation works for somebody with no account yet: register, verify, and they are in with the invited role',
    T,
    async () => {
      const owner = await account('Olga Owner');
      const teamId = await makeTeam('Acme', owner.email);

      const role = await api(owner.page, 'POST', `/api/teams/${teamId}/roles`, {
        name: 'Reviewer',
        permissions: EDIT_PAGES,
      });
      assert.equal(role.status, 201, JSON.stringify(role.body));

      // --- the owner invites an address that has no account, with that role
      const invitee = uniqueEmail('new');
      await settings(owner.page, teamId, 'invites');
      await owner.page.locator('[data-role-pick="Reviewer"] input').check();
      await owner.page.fill('[data-field=addresses]', invitee);
      const since = Date.now() - 2000;
      await owner.page.click('[data-action=send-invites]');
      await owner.page.locator(`[data-invite="${invitee}"]`).waitFor();
      assert.equal(
        await owner.page.locator(`[data-invite="${invitee}"]`).getAttribute('data-status'),
        'active',
      );

      // --- the mail links to /invite/<token>
      const url = linkIn(await waitForMail(invitee, 'invited', { since }));
      assert.match(url, /\/invite\/[A-Za-z0-9_-]{20,}$/);

      // --- a visitor sees the team and nothing about who is in it
      const visitor = await device();
      await visitor.page.goto(url);
      await visitor.page.locator('[data-invite-team]').waitFor();
      assert.equal(await visitor.page.locator('[data-invite-team]').innerText(), 'Acme');
      assert.doesNotMatch(await visitor.page.locator('body').innerText(), /Olga|Owner/);

      // --- creates an account with the invited address, verifies it, and is in the team with the role
      await visitor.page.click('[data-action=invite-register]');
      await visitor.page.waitForSelector('[data-register-invite]');
      await visitor.page.fill('input[name=name]', 'Nina Newcomer');
      await visitor.page.fill('input[name=email]', invitee);
      await visitor.page.fill('input[name=password]', PASSWORD);
      await visitor.page.click('button[type=submit]');
      await visitor.page.waitForURL('**/invite/**');
      await visitor.page.waitForSelector('[data-invite-verify]'); // not in yet: the address is not verified
      assert.equal(
        Number(
          (await sql('SELECT COUNT(*) AS n FROM `TeamMember` WHERE teamId = ?', [teamId]))[0].n,
        ),
        1,
      );

      await verify(visitor.page, invitee);
      await visitor.page.goto(`${base}/app`);
      await visitor.page.locator('app-rail [data-team="Acme"]').waitFor();
      const members = await api(visitor.page, 'GET', `/api/teams/${teamId}/members`);
      const nina = members.body.find((m) => m.displayName === 'Nina Newcomer');
      assert.ok(nina, 'the newcomer is a member');
      assert.deepEqual(nina.roleIds, [role.body.id]);

      // --- the owner's list shows the invitation as used
      await settings(owner.page, teamId, 'invites');
      await owner.page.locator(`[data-invite="${invitee}"][data-status="used"]`).waitFor();

      for (const d of [owner, visitor]) assert.deepEqual(d.problems, []);
      await Promise.all([owner.close(), visitor.close()]);
    },
  );

  test(
    'an invite link: a signed-out visitor with an account signs in and joins; used-up and withdrawn links are the same dead end',
    T,
    async () => {
      const owner = await account('Olga Linker');
      const teamId = await makeTeam('Beta', owner.email);

      // --- the owner makes a link for one person, from the settings page
      await settings(owner.page, teamId, 'invites');
      await owner.page.fill('[data-field=max-uses]', '1');
      await owner.page.click('[data-action=create-link]');
      const url = await owner.page.locator('[data-invite-url]').inputValue();
      assert.match(url, /\/invite\/[A-Za-z0-9_-]{20,}$/);

      // --- Bob has an account but is signed out on this device
      const bob = await account('Bob Builder');
      const bobOut = await device();
      await bobOut.page.goto(url);
      await bobOut.page.locator('[data-invite-team]').waitFor();
      assert.equal(await bobOut.page.locator('[data-invite-team]').innerText(), 'Beta');
      assert.doesNotMatch(
        await bobOut.page.locator('body').innerText(),
        /Olga|Linker/,
        'no member names before sign-in',
      );
      await bobOut.page.click('[data-action=invite-login]');
      await bobOut.page.fill('input[name=email]', bob.email);
      await bobOut.page.fill('input[name=password]', PASSWORD);
      await bobOut.page.click('button[type=submit]');
      await bobOut.page.waitForURL('**/invite/**'); // back to the invitation, now signed in
      await bobOut.page.click('[data-action=invite-join]');
      await bobOut.page.waitForSelector('[data-team-page]');
      await bobOut.page.locator('app-rail [data-team="Beta"]').waitFor();

      // --- the link had one use: for the next person it is a dead end
      const carl = await account('Carl Late');
      await carl.page.goto(url);
      await carl.page.locator('[data-invite-invalid]').waitFor();
      const used = await carl.page.locator('[data-invite-page]').innerText();

      // --- a link that was withdrawn looks exactly the same
      const second = await linkToken(owner, teamId);
      await settings(owner.page, teamId, 'invites');
      const row = owner.page.locator('[data-invite="link"][data-status="active"]');
      await row.locator('[data-action=revoke]').click();
      await confirmDialog(owner.page);
      await owner.page.locator('[data-invite="link"][data-status="revoked"]').waitFor();
      await carl.page.goto(`${base}/invite/${second}`);
      await carl.page.locator('[data-invite-invalid]').waitFor();
      assert.equal(await carl.page.locator('[data-invite-page]').innerText(), used);

      for (const d of [owner, bob, bobOut, carl]) assert.deepEqual(d.problems, []);
      await Promise.all([owner.close(), bob.close(), bobOut.close(), carl.close()]);
    },
  );

  test('a public team that works by request: ask, approve, deny, ask again', T, async () => {
    const owner = await account('Olga Host');
    const teamId = await makeTeam('Gamma', owner.email);

    // --- the owner lists the team in the directory, by request
    await settings(owner.page, teamId, 'discover');
    await owner.page.check('[data-field=is-public]');
    await owner.page.selectOption('[data-field=policy]', 'request');
    await owner.page.fill('[data-field=blurb]', 'We make gamma rays');
    await owner.page.fill('[data-field=tags]', 'Physics, Rays');
    await owner.page.click('[data-action=save-discover]');
    await owner.page.waitForSelector('text=Saved.');

    // --- Cleo finds it in the directory and asks to join
    const cleo = await account('Cleo Curious');
    await cleo.page.click('app-rail [data-rail=directory]');
    const card = cleo.page.locator('[data-directory-team="Gamma"]');
    await card.waitFor();
    assert.match(await card.innerText(), /We make gamma rays/);
    assert.deepEqual(await card.locator('[data-tag]').allInnerTexts(), ['physics', 'rays']);
    await card.locator('[data-action=request-join]').click();
    await answerPrompt(cleo.page, 'Hello from Cleo');
    await card.locator('[data-requested]').waitFor();

    // --- the owner sees a badge, then the request, and approves it
    await owner.page.goto(`${base}/app`);
    await owner.page.locator('app-rail [data-rail-badge="Gamma"]').waitFor();
    assert.equal(await owner.page.locator('app-rail [data-rail-badge="Gamma"]').innerText(), '1');
    await settings(owner.page, teamId, 'requests');
    const request = owner.page.locator('[data-request="Cleo Curious"]');
    await request.waitFor();
    assert.match(await request.innerText(), /Hello from Cleo/);
    await request.locator('[data-action=approve]').click();
    await owner.page.locator('[data-no-requests]').waitFor();

    // --- Cleo reloads (live updates come with phase 6) and the team is in her rail
    await cleo.page.reload();
    await cleo.page.locator('app-rail [data-team="Gamma"]').waitFor();
    const mail = await waitForMail(cleo.email, 'You are in');
    assert.match(mail, /approved/);

    // --- Dan is turned down: a neutral state, and he can ask again
    const dan = await account('Dan Denied');
    await dan.page.goto(`${base}/app/directory`);
    const danCard = dan.page.locator('[data-directory-team="Gamma"]');
    await danCard.locator('[data-action=request-join]').click();
    await answerPrompt(dan.page, '');
    await danCard.locator('[data-requested]').waitFor();
    await settings(owner.page, teamId, 'requests');
    await owner.page.locator('[data-request="Dan Denied"] [data-action=deny]').click();
    await owner.page.locator('[data-no-requests]').waitFor();
    await dan.page.reload();
    await dan.page.locator('[data-directory-team="Gamma"] [data-action=request-join]').waitFor(); // asks again
    assert.equal(await dan.page.locator('app-rail [data-team="Gamma"]').count(), 0);
    await dan.page.locator('[data-directory-team="Gamma"] [data-action=request-join]').click();
    await answerPrompt(dan.page, 'Please?');
    await settings(owner.page, teamId, 'requests');
    await owner.page.locator('[data-request="Dan Denied"]').waitFor();

    for (const d of [owner, cleo, dan]) assert.deepEqual(d.problems, []);
    await Promise.all([owner.close(), cleo.close(), dan.close()]);
  });

  test(
    'leaving and being removed: the team goes from the rail and from the local database, and the server revokes its spaces',
    T,
    async () => {
      const owner = await account('Olga Leaver');
      const teamId = await makeTeam('Delta', owner.email);
      const eve = await account('Eve Leaver');
      const fay = await account('Fay Kicked');
      const token = await linkToken(owner, teamId);
      for (const who of [eve, fay]) {
        const res = await api(who.page, 'POST', '/api/invites/accept', { token });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        await who.page.goto(`${base}/app`);
        await who.page.locator('app-rail [data-team="Delta"]').waitFor();
      }
      const team = (await api(eve.page, 'GET', `/api/teams/${teamId}`)).body;
      assert.deepEqual(await localTeams(eve.page, await userId(eve.email)), ['Delta']);

      // --- Eve leaves from the members tab
      await settings(eve.page, teamId, 'members');
      await eve.page.click('[data-action=leave-team]');
      await confirmDialog(eve.page);
      await eve.page.waitForURL('**/app');
      await eve.page.waitForSelector('app-rail');
      assert.equal(await eve.page.locator('app-rail [data-team="Delta"]').count(), 0);
      assert.deepEqual(await localTeams(eve.page, await userId(eve.email)), []);
      await eve.page.reload();
      await eve.page.waitForSelector('app-rail');
      assert.equal(await eve.page.locator('app-rail [data-team="Delta"]').count(), 0);

      // --- the owner removes Fay from the members tab
      const fayId = await userId(fay.email);
      await settings(owner.page, teamId, 'members');
      await owner.page.locator(`[data-member-id="${fayId}"] [data-action=member-menu]`).click();
      await owner.page.click('[data-action=kick]');
      await confirmDialog(owner.page);
      await owner.page.locator(`[data-member-id="${fayId}"]`).waitFor({ state: 'detached' });

      // --- Fay's device is told the space is gone on its next sync
      const changes = await api(
        fay.page,
        'GET',
        `/api/sync/changes?cursors=${encodeURIComponent(JSON.stringify({ [team.spaceId]: 0 }))}`,
      );
      assert.deepEqual(changes.body.revokedSpaces, [team.spaceId]);
      await fay.page.reload();
      await fay.page.waitForSelector('app-rail');
      await fay.page.waitForFunction(
        () => document.querySelectorAll('app-rail [data-team="Delta"]').length === 0,
      );
      assert.deepEqual(await localTeams(fay.page, fayId), []);

      // --- the owner cannot leave without handing the team over
      await settings(owner.page, teamId, 'members');
      assert.equal(await owner.page.locator('[data-action=leave-team]').count(), 0);
      assert.equal(await owner.page.locator('[data-transfer-form]').count(), 1);

      for (const d of [owner, eve, fay]) assert.deepEqual(d.problems, []);
      await Promise.all([owner.close(), eve.close(), fay.close()]);
    },
  );
});
