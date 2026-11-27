// End-to-end: shared notebooks and share links (phase 10). The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  launch,
  makePng,
  register,
  sql,
  startStack,
  uniqueEmail,
  verify,
  waitForOfflineReady,
  waitSaved,
  PASSWORD,
} from './harness.mjs';

const T = { timeout: 300_000 };
const ADMIN_EMAIL = uniqueEmail('admin');
const EDIT_PAGES = '524288';
const VIEW_NOTEBOOKS = '131072';

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

async function uploadImage(page, id) {
  const base64 = (await makePng(40, 30)).toString('base64');
  return page.evaluate(
    async ([mediaId, data]) => {
      const refresh = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'X-Requested-With': 'os_planner' },
      });
      const { accessToken } = await refresh.json();
      const form = new FormData();
      form.append('id', mediaId);
      form.append(
        'file',
        new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: 'image/png' }),
        'a.png',
      );
      return (
        await fetch('/api/media', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
          body: form,
        })
      ).status;
    },
    [id, base64],
  );
}

const para = (text) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** A notebook with pages, made through the API: `{ id, categoryId, pages: [{ id, title }] }`. */
async function seed(page, name, pages, { spaceId, image } = {}) {
  const id = randomUUID();
  const made = await api(page, 'POST', '/api/notebooks', {
    id,
    name,
    position: 'a0',
    ...(spaceId ? { spaceId } : {}),
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const tree = await api(page, 'GET', `/api/notebooks/${id}/tree`);
  const categoryId = tree.body.categories[0].id;
  const out = [];
  let pos = 'a0';
  for (const p of pages) {
    const pid = randomUUID();
    pos = pos + '0';
    assert.equal(
      (
        await api(page, 'POST', '/api/pages', {
          id: pid,
          categoryId,
          title: p.title,
          position: pos,
        })
      ).status,
      201,
    );
    let content = para(p.text);
    if (p.image) {
      assert.equal(await uploadImage(page, image), 201);
      content = {
        type: 'doc',
        content: [
          ...para(p.text).content,
          {
            type: 'imageFigure',
            attrs: { mediaId: image, alt: 'pic', caption: '', width: null, align: 'center' },
          },
        ],
      };
    }
    assert.equal(
      (await api(page, 'POST', `/api/pages/${pid}/snapshots/replace`, { content, baseVersion: 0 })).status,
      200,
    );
    out.push({ id: pid, title: p.title });
  }
  return { id, categoryId, pages: out };
}

const userId = async (email) => (await sql('SELECT id FROM `User` WHERE email = ?', [email]))[0].id;

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
const addMember = async (teamId, email) =>
  sql('INSERT INTO `TeamMember` (teamId, userId, joinedAt) VALUES (?, ?, NOW(3))', [
    teamId,
    await userId(email),
  ]);

/** Opens a notebook's menu in the sidebar and chooses an item. */
async function notebookMenu(page, name, action) {
  const row = page.locator(`[data-notebook="${name}"]`).first();
  await row.waitFor();
  await row.hover();
  await row.locator('[data-notebook-menu]').click();
  await page.locator(`[data-action="${action}"]`).click();
}

const editable = (page) => page.locator('.ProseMirror.doc').getAttribute('contenteditable');

describe('notebooks shared with people', () => {
  test('edit by name, read-only live, removed: the recipient follows each change', T, async () => {
    const alice = await account('Ana Owner');
    const bea = await account('Bea Sharer');
    const teamId = await makeTeam('Sharers', alice.email);
    await addMember(teamId, bea.email);

    const nb = await seed(alice.page, 'Plans', [{ title: 'First', text: 'plan one' }]);
    await alice.page.reload();
    await alice.page.waitForSelector('[data-notebook="Plans"]');

    // --- Ana shares it with Bea (by name, can edit)
    await notebookMenu(alice.page, 'Plans', 'share');
    await alice.page.fill('[data-field="share-who"]', 'Bea Sharer');
    await alice.page.selectOption('[data-field="share-access"]', 'edit');
    await alice.page.click('[data-action="share-add"]');
    await alice.page.locator('[data-share="Bea Sharer"]').waitFor();

    // --- Bea finds it under "Shared with me" and edits it
    await bea.page.locator('[data-section="shared"]').waitFor({ timeout: 40_000 });
    await bea.page.locator('app-tree-category a.link', { hasText: 'First' }).click();
    // A page this device has never opened is shown from its saved copy (read-only) until the server's version arrives, then it is editable.
    await bea.page.waitForSelector('.ProseMirror.doc[contenteditable="true"]');
    assert.match(await bea.page.locator('.ProseMirror').textContent(), /plan one/);
    await bea.page.locator('.ProseMirror').click();
    await bea.page.keyboard.press('Control+End');
    await bea.page.keyboard.type(' and Bea added this.');
    await waitSaved(bea.page);
    await bea.page.waitForFunction(() =>
      document.querySelector('.state')?.textContent?.includes('Saved'),
    );
    await alice.page.waitForTimeout(500);
    let seen = '';
    for (let i = 0; i < 30 && !seen.includes('Bea added this.'); i++) {
      seen = JSON.stringify(
        (await api(alice.page, 'GET', `/api/pages/${nb.pages[0].id}`)).body.content,
      );
      if (!seen.includes('Bea added this.')) await alice.page.waitForTimeout(1000);
    }
    assert.match(seen, /Bea added this\./, 'the edit reached the owner');

    // --- Ana makes it read-only: Bea's open editor stops accepting input, without a reload
    await alice.page.locator('[data-share="Bea Sharer"] select').selectOption('read');
    await bea.page.waitForSelector('.ProseMirror.doc[contenteditable="false"]', {
      timeout: 40_000,
    });
    await bea.page.waitForSelector('[data-read-only]');
    await bea.page.keyboard.type('nothing should land here');
    assert.doesNotMatch(
      await bea.page.locator('.ProseMirror').textContent(),
      /nothing should land here/,
    );

    // --- Ana removes Bea: the section goes away
    await alice.page.locator('[data-share="Bea Sharer"] [data-action="share-remove"]').click();
    await alice.page.locator('[data-share="Bea Sharer"]').waitFor({ state: 'detached' });
    await bea.page.waitForSelector('[data-section="shared"]', {
      state: 'detached',
      timeout: 40_000,
    });

    assert.deepEqual([...alice.problems, ...bea.problems], []);
    await Promise.all([alice.close(), bea.close()]);
  });

  test(
    'a notebook opened before going offline stays readable, and a read-only share queues nothing',
    T,
    async () => {
      const alice = await account('Ola Owner');
      const ben = await account('Ben Reader');
      const teamId = await makeTeam('Offliners', alice.email);
      await addMember(teamId, ben.email);
      const nb = await seed(alice.page, 'Shared read', [
        { title: 'Readable', text: 'keep this around' },
      ]);
      assert.equal(
        (
          await api(alice.page, 'PUT', `/api/notebooks/${nb.id}/shares`, {
            userId: await userId(ben.email),
            access: 'read',
          })
        ).status,
        200,
      );

      await ben.page.locator('[data-section="shared"]').waitFor({ timeout: 40_000 });
      await ben.page.locator('app-tree-category a.link', { hasText: 'Readable' }).click();
      await ben.page.waitForSelector('.ProseMirror.doc');
      assert.match(await ben.page.locator('.ProseMirror').textContent(), /keep this around/);
      await waitForOfflineReady(ben.page);
      await ben.page.reload();
      await ben.page.waitForSelector('.ProseMirror.doc');

      await ben.ctx.setOffline(true);
      await ben.page.reload();
      await ben.page.waitForSelector('.ProseMirror.doc', { timeout: 30_000 });
      await ben.page.waitForFunction(
        () => /keep this around/.test(document.querySelector('.ProseMirror')?.textContent ?? ''),
        null,
        { timeout: 30_000 },
      );
      assert.equal(await editable(ben.page), 'false');
      await ben.page.locator('.ProseMirror').click();
      await ben.page.keyboard.type('offline typing');
      await ben.page.waitForTimeout(1500);

      const queued = await ben.page.evaluate(async () => {
        const names = (await indexedDB.databases())
          .map((d) => d.name)
          .filter((n) => n?.startsWith('os_planner-'));
        const db = await new Promise((ok) => {
          const q = indexedDB.open(names[0]);
          q.onsuccess = () => ok(q.result);
        });
        const all = (store) =>
          new Promise(
            (ok) =>
              (db.transaction(store).objectStore(store).getAll().onsuccess = (e) =>
                ok(e.target.result)),
          );
        return {
          outbox: (await all('outbox')).length,
          dirty: (await all('contents')).filter((c) => c.dirty === 1).length,
        };
      });
      assert.deepEqual(queued, { outbox: 0, dirty: 0 });
      assert.doesNotMatch(await ben.page.locator('.ProseMirror').textContent(), /offline typing/);
      await ben.ctx.setOffline(false);
      await Promise.all([alice.close(), ben.close()]);
    },
  );
});

describe('share links', () => {
  test(
    'a read link opens without the app, shows the tree, search and pictures, and revoking closes it',
    T,
    async () => {
      const alice = await account('Lia Linker');
      const image = randomUUID();
      const nb = await seed(
        alice.page,
        'Public book',
        [
          { title: 'Welcome', text: 'a needle in the text', image },
          { title: 'Second', text: 'other words' },
        ],
        { image },
      );
      await alice.page.reload();
      await alice.page.waitForSelector('[data-notebook="Public book"]');

      await notebookMenu(alice.page, 'Public book', 'share');
      await alice.page.click('[data-tab="link"]');
      await alice.page.click('[data-action="make-link"]');
      const address = await alice.page.locator('[data-link-url]').first().inputValue();
      assert.match(address, /\/s\/[A-Za-z0-9_-]{40,}$/);

      // --- somebody with no account and no session opens it
      const visitor = await device();
      const requests = [];
      visitor.page.on('request', (r) => requests.push(new URL(r.url())));
      await visitor.page.goto(address);
      await visitor.page.locator('[data-public-reader]').waitFor();
      assert.equal(await visitor.page.locator('app-shell').count(), 0, 'no app shell');
      await visitor.page.locator('[data-page="Second"]').waitFor();
      await visitor.page.locator('[data-page="Welcome"]').click();
      await visitor.page.locator('[data-reader-title]', { hasText: 'Welcome' }).waitFor();
      await visitor.page.locator('.content .ProseMirror').waitFor();
      assert.match(
        await visitor.page.locator('.content .ProseMirror').textContent(),
        /a needle in the text/,
      );
      await visitor.page.waitForFunction(() => {
        const img = document.querySelector('.content img');
        return !!img && img.complete && img.naturalWidth > 0;
      });
      await visitor.page.fill('[data-field="reader-search"]', 'needle');
      await visitor.page.locator('[data-hit="Welcome"]').waitFor();

      const apiCalls = requests.filter((u) => u.pathname.startsWith('/api/'));
      assert.ok(apiCalls.length > 0);
      assert.deepEqual(
        apiCalls.filter((u) => !u.pathname.startsWith('/api/links/')).map((u) => u.pathname),
        [],
        'only the link endpoints are used',
      );
      assert.equal(
        await visitor.page.evaluate(
          () => Object.keys(localStorage).filter((k) => k.startsWith('os_planner.lastUser')).length,
        ),
        0,
      );
      assert.equal(
        await visitor.page.evaluate(async () => (await indexedDB.databases()).length),
        0,
        'no local database',
      );

      // --- revoking ends it for the next visit
      await alice.page.locator('[data-action="revoke-link"]').first().click();
      await alice.page.locator('[data-link]').waitFor({ state: 'detached' });
      await visitor.page.reload();
      await visitor.page.locator('[data-link-invalid]').waitFor();
      assert.equal(await visitor.page.locator('[data-public-reader]').count(), 0);

      assert.deepEqual([...alice.problems, ...visitor.problems], []);
      await Promise.all([alice.close(), visitor.close()]);
      void nb;
    },
  );

  test(
    'an edit link asks for the password, then for a sign-in, and the edit reaches the owner',
    T,
    async () => {
      const alice = await account('Eva Editor');
      const bob = await account('Bo Visitor');
      const nb = await seed(alice.page, 'Joint book', [{ title: 'Draft', text: 'draft text' }]);
      await alice.page.reload();
      await alice.page.waitForSelector('[data-notebook="Joint book"]');

      await notebookMenu(alice.page, 'Joint book', 'share');
      await alice.page.click('[data-tab="link"]');
      await alice.page.selectOption('[data-field="link-access"]', 'edit');
      await alice.page.fill('[data-field="link-password"]', 'sesame-open');
      await alice.page.click('[data-action="make-link"]');
      const address = await alice.page.locator('[data-link-url]').first().inputValue();

      // --- a visitor who is not signed in: password first
      const visitor = await device();
      await visitor.page.goto(address);
      await visitor.page.locator('[data-link-password]').waitFor();
      await visitor.page.fill('[data-field="reader-password"]', 'wrong one');
      await visitor.page.keyboard.press('Enter');
      await visitor.page.locator('[data-wrong-password]').waitFor();
      await visitor.page.fill('[data-field="reader-password"]', 'sesame-open');
      await visitor.page.keyboard.press('Enter');
      await visitor.page.locator('[data-public-reader]').waitFor();
      assert.match(
        await visitor.page.locator('[data-action="edit-link"]').textContent(),
        /Sign in to edit/,
      );

      // --- editing needs a login
      await visitor.page.click('[data-action="edit-link"]');
      await visitor.page.waitForURL('**/login**');
      await visitor.page.fill('input[name=email]', bob.email);
      await visitor.page.fill('input[name=password]', PASSWORD);
      await visitor.page.click('button[type=submit]');
      await visitor.page.locator('[data-link-password]').waitFor(); // back at the link, which still wants its password
      await visitor.page.fill('[data-field="reader-password"]', 'sesame-open');
      await visitor.page.keyboard.press('Enter');

      await visitor.page.waitForURL('**/app/p/**');
      await visitor.page.waitForSelector('.ProseMirror.doc[contenteditable="true"]', {
        timeout: 40_000,
      });
      await visitor.page.locator('.ProseMirror').click();
      await visitor.page.keyboard.press('Control+End');
      await visitor.page.keyboard.type(' plus words from the link.');
      await waitSaved(visitor.page);

      let seen = '';
      for (let i = 0; i < 30 && !seen.includes('words from the link.'); i++) {
        seen = JSON.stringify(
          (await api(alice.page, 'GET', `/api/pages/${nb.pages[0].id}`)).body.content,
        );
        if (!seen.includes('words from the link.')) await alice.page.waitForTimeout(1000);
      }
      assert.match(seen, /words from the link\./);

      // --- revoking the link ends Bo's access to it
      await alice.page.locator('[data-action="revoke-link"]').first().click();
      await alice.page.locator('[data-link]').waitFor({ state: 'detached' });
      await visitor.page.waitForSelector('[data-section="shared"]', {
        state: 'detached',
        timeout: 40_000,
      });

      assert.deepEqual([...alice.problems, ...visitor.problems], []);
      await Promise.all([alice.close(), visitor.close(), bob.close()]);
    },
  );
});

describe('team notebooks', () => {
  test(
    'viewers read, editors write, and an overwrite that denies viewing makes it not found',
    T,
    async () => {
      const owner = await account('Tia Owner');
      const member = await account('Mo Member');
      const teamId = await makeTeam('Notebook team', owner.email);
      await addMember(teamId, member.email);
      const teamSpace = (await sql('SELECT spaceId FROM `Team` WHERE id = ?', [teamId]))[0].spaceId;
      const nb = await seed(owner.page, 'Team book', [{ title: 'Charter', text: 'team words' }], {
        spaceId: teamSpace,
      });

      // --- the member sees it in the team's sidebar, read-only
      await member.page.goto(`${base}/app/t/${teamId}`);
      await member.page.waitForSelector('[data-section="team-notebooks"]');
      await member.page.locator('app-tree-category a.link', { hasText: 'Charter' }).click();
      await member.page.waitForSelector('.ProseMirror.doc');
      assert.equal(await editable(member.page), 'false');
      await member.page.waitForSelector('[data-read-only]');
      assert.equal(
        await member.page.locator('[data-action="new-notebook"]').count(),
        0,
        'no way to create one',
      );

      // --- a role with EDIT_PAGES: the open page turns editable by itself
      const role = await api(owner.page, 'POST', `/api/teams/${teamId}/roles`, {
        name: 'Editors',
        permissions: EDIT_PAGES,
      });
      assert.equal(role.status, 201);
      assert.equal(
        (
          await api(
            owner.page,
            'PUT',
            `/api/teams/${teamId}/members/${await userId(member.email)}/roles/${role.body.id}`,
          )
        ).status,
        204,
      );
      await member.page.waitForSelector('.ProseMirror.doc[contenteditable="true"]', {
        timeout: 40_000,
      });
      await member.page.locator('.ProseMirror').click();
      await member.page.keyboard.press('Control+End');
      await member.page.keyboard.type(' edited by a member.');
      await waitSaved(member.page);
      let seen = '';
      for (let i = 0; i < 30 && !seen.includes('edited by a member.'); i++) {
        seen = JSON.stringify(
          (await api(owner.page, 'GET', `/api/pages/${nb.pages[0].id}`)).body.content,
        );
        if (!seen.includes('edited by a member.')) await owner.page.waitForTimeout(1000);
      }
      assert.match(seen, /edited by a member\./);

      // --- the owner denies viewing this notebook to the member
      const deny = await api(owner.page, 'PUT', '/api/overwrites', {
        targetKind: 'notebook',
        targetId: nb.id,
        subjectKind: 'member',
        subjectId: await userId(member.email),
        allow: '0',
        deny: VIEW_NOTEBOOKS,
      });
      assert.equal(deny.status, 200, JSON.stringify(deny.body));
      await member.page.waitForSelector('[data-notebook="Team book"]', {
        state: 'detached',
        timeout: 40_000,
      });
      await member.page.goto(`${base}/app/p/${nb.pages[0].id}`);
      await member.page.waitForSelector('text=could not be found');

      // the owner still sees it
      await owner.page.goto(`${base}/app/t/${teamId}`);
      await owner.page.locator('[data-notebook="Team book"]').first().waitFor();

      assert.deepEqual([...owner.problems, ...member.problems], []);
      await Promise.all([owner.close(), member.close()]);
    },
  );
});

describe('moving a notebook', () => {
  test(
    'personal -> team: it leaves the personal list, shows up for the team, and its link stops working',
    T,
    async () => {
      const owner = await account('Max Mover');
      const member = await account('Mia Member');
      const teamId = await makeTeam('Move team', owner.email);
      await addMember(teamId, member.email);
      const teamSpace = (await sql('SELECT spaceId FROM `Team` WHERE id = ?', [teamId]))[0].spaceId;
      const nb = await seed(owner.page, 'Wanderer', [{ title: 'Trip', text: 'moving words' }]);
      const link = await api(owner.page, 'POST', `/api/notebooks/${nb.id}/links`, {
        access: 'read',
      });
      assert.equal(link.status, 201);

      await owner.page.reload();
      await notebookMenu(owner.page, 'Wanderer', 'move-notebook');
      await owner.page.locator('[data-space="Move team"]').click();
      await owner.page.locator('[data-move-warning]').waitFor();
      await owner.page.click('[data-action="confirm-move"]');
      await owner.page.waitForSelector('mat-dialog-container', { state: 'detached' });
      await owner.page.waitForSelector('[data-notebook="Wanderer"]', {
        state: 'detached',
        timeout: 40_000,
      });

      // the team has it now (the owner and a plain member alike), and the file of rows says so
      for (const who of [owner, member]) {
        await who.page.goto(`${base}/app/t/${teamId}`);
        await who.page
          .locator('[data-section="team-notebooks"] ~ app-tree [data-notebook="Wanderer"]')
          .first()
          .waitFor({ timeout: 40_000 });
      }
      assert.equal(
        (await sql('SELECT spaceId FROM `Notebook` WHERE id = ?', [nb.id]))[0].spaceId,
        teamSpace,
      );
      // the link made before the move does not follow
      const visitor = await device();
      await visitor.page.goto(link.body.url);
      await visitor.page.locator('[data-link-invalid]').waitFor();

      assert.deepEqual([...owner.problems, ...member.problems, ...visitor.problems], []);
      await Promise.all([owner.close(), member.close(), visitor.close()]);
    },
  );
});
