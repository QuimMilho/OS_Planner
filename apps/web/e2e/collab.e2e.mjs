// End-to-end: real-time co-editing (phase 11). The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  launch,
  register,
  startStack,
  verify,
  waitForOfflineReady,
  waitSaved,
} from './harness.mjs';

const T = { timeout: 300_000 };

let stack;
let browser;
let base;

before(async () => {
  stack = await startStack({
    env: { COLLAB_DEBOUNCE_MS: '150', COLLAB_MAX_DEBOUNCE_MS: '600', COLLAB_RECHECK_MS: '2000' },
  });
  base = stack.baseUrl;
  browser = await launch();
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
async function account(name) {
  const d = await device();
  const { email } = await register(d.page, base, { name });
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

const para = (text) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** A notebook with one page holding `text`, made through the API by `owner`. */
async function seed(owner, text = 'Original text.') {
  const notebookId = randomUUID();
  assert.equal(
    (
      await api(owner.page, 'POST', '/api/notebooks', {
        id: notebookId,
        name: 'Co-edit',
        position: 'a0',
      })
    ).status,
    201,
  );
  const tree = await api(owner.page, 'GET', `/api/notebooks/${notebookId}/tree`);
  const categoryId = tree.body.categories[0].id;
  const pageId = randomUUID();
  assert.equal(
    (
      await api(owner.page, 'POST', '/api/pages', {
        id: pageId,
        categoryId,
        title: 'Shared page',
        position: 'a0',
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await api(owner.page, 'POST', `/api/pages/${pageId}/snapshots/replace`, {
        content: para(text),
        baseVersion: 0,
      })
    ).status,
    200,
  );
  return { notebookId, pageId };
}

const share = async (owner, notebookId, to, access) => {
  const res = await api(owner.page, 'PUT', `/api/notebooks/${notebookId}/shares`, {
    email: to.email,
    access,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

/** Opens the page for `who`, and waits until it is live. */
async function open(who, pageId, { live = true } = {}) {
  await who.page.goto(`${base}/app/p/${pageId}`);
  await who.page.waitForSelector('.ProseMirror.doc');
  if (live) await who.page.waitForSelector('.conn[data-conn="live"]', { timeout: 30_000 });
}

/** The text of the page, without other people's cursor labels (which sit inside it). */
const pageText = () => {
  const el = document.querySelector('.ProseMirror')?.cloneNode(true);
  el?.querySelectorAll('.collaboration-carets__caret').forEach((c) => c.remove());
  return el?.textContent ?? '';
};
const textOf = (page) => page.evaluate(pageText);
const waitText = (page, re, timeout = 20_000) =>
  page.waitForFunction(
    (src) => {
      const el = document.querySelector('.ProseMirror')?.cloneNode(true);
      el?.querySelectorAll('.collaboration-carets__caret').forEach((c) => c.remove());
      return new RegExp(src).test(el?.textContent ?? '');
    },
    re.source,
    { timeout },
  );
const endOfDoc = async (page) => {
  await page.locator('.ProseMirror').focus();
  await page.keyboard.press('Control+End');
};
const slash = async (page, query) => {
  await page.keyboard.type(`/${query}`);
  await page.waitForSelector('.slash button');
  await page.keyboard.press('Enter');
};
const serverContent = async (page, pageId) =>
  JSON.stringify((await api(page, 'GET', `/api/pages/${pageId}`)).body.content);

describe('two people in one page', () => {
  test(
    'typing, formatting, a table and a chart appear live for both with named cursors; a reader sees them but cannot type',
    T,
    async () => {
      const alice = await account('Alice Writer');
      const bob = await account('Bob Editor');
      const carol = await account('Carol Reader');
      const { notebookId, pageId } = await seed(alice);
      await share(alice, notebookId, bob, 'edit');
      await share(alice, notebookId, carol, 'read');

      await open(alice, pageId);
      await open(bob, pageId);
      await open(carol, pageId);
      await waitText(bob.page, /Original text\./);

      // typing
      await endOfDoc(alice.page);
      await alice.page.keyboard.type(' Alice was here.');
      await waitText(bob.page, /Alice was here\./);
      await waitText(carol.page, /Alice was here\./);

      // the other person's cursor, with their name; and who is in the page
      await bob.page.waitForSelector('.collaboration-carets__label:has-text("Alice Writer")', {
        timeout: 15_000,
      });
      await alice.page.waitForSelector('[data-peers]');
      assert.ok((await alice.page.locator('[data-peer]').count()) >= 1);

      // typing the other way, in the same paragraph, at the same time
      await endOfDoc(bob.page);
      await bob.page.keyboard.type(' Bob too.');
      await waitText(alice.page, /Bob too\./);
      await alice.page.waitForSelector('.collaboration-carets__label:has-text("Bob Editor")', {
        timeout: 15_000,
      });

      // formatting
      await alice.page.keyboard.press('Control+a');
      await alice.page.keyboard.press('Control+b');
      await bob.page.waitForSelector('.ProseMirror strong', { timeout: 15_000 });
      await alice.page.keyboard.press('Control+b');
      await endOfDoc(alice.page);

      // a table and a chart
      await alice.page.keyboard.press('Enter');
      await slash(alice.page, 'table');
      await bob.page.waitForSelector('.ProseMirror table', { timeout: 15_000 });
      await endOfDoc(alice.page);
      await alice.page.keyboard.press('Enter');
      await slash(alice.page, 'chart');
      await alice.page.waitForSelector('app-chart-view canvas', { timeout: 30_000 });
      await bob.page.waitForSelector('app-chart-view canvas', { timeout: 30_000 });
      await carol.page.waitForSelector('app-chart-view canvas', { timeout: 30_000 });

      // the reader sees all of it, cannot type, and is told
      assert.equal(
        await carol.page.locator('.ProseMirror.doc').getAttribute('contenteditable'),
        'false',
      );
      await carol.page.waitForSelector('[data-read-only]');
      const before = await textOf(carol.page);
      await carol.page.locator('.ProseMirror').click({ position: { x: 20, y: 10 } });
      await carol.page.keyboard.type('carol typed this');
      await carol.page.waitForTimeout(800);
      assert.equal(await textOf(carol.page), before);
      assert.doesNotMatch(await textOf(alice.page), /carol typed this/);

      // and the server has it all, derived for search and export
      await alice.page.waitForFunction(() =>
        /Saved(?! on this device)/.test(document.querySelector('.state')?.textContent ?? ''),
      );
      await alice.page.waitForTimeout(800);
      const stored = await serverContent(alice.page, pageId);
      for (const part of ['Alice was here', 'Bob too', '"table"', '"chart"'])
        assert.ok(stored.includes(part), `server content has ${part}`);
      assert.deepEqual(alice.problems, []);
      for (const d of [alice, bob, carol]) await d.close();
    },
  );
});

describe('working offline', () => {
  /** How many "before a merge" copies this device holds of any page. */
  const localSnapshots = (page) =>
    page.evaluate(async () => {
      const dbs = (await indexedDB.databases()).filter((d) => d.name?.startsWith('os_planner-'));
      let n = 0;
      for (const info of dbs) {
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open(info.name);
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        if (db.objectStoreNames.contains('localHistory')) {
          n += await new Promise((res) => {
            const r = db.transaction('localHistory').objectStore('localHistory').count();
            r.onsuccess = () => res(r.result);
          });
        }
        db.close();
      }
      return n;
    });

  test(
    'both edit the same paragraph offline, then reconnect: the merged page has both edits, no conflict copy, and a local snapshot exists',
    T,
    async () => {
      const alice = await account('Alice Offline');
      const bob = await account('Bob Offline');
      const { notebookId, pageId } = await seed(alice, 'Original text.');
      await share(alice, notebookId, bob, 'edit');
      await open(alice, pageId);
      await open(bob, pageId);
      await waitText(bob.page, /Original text\./);
      await waitForOfflineReady(alice.page);
      await waitForOfflineReady(bob.page);

      await alice.ctx.setOffline(true);
      await bob.ctx.setOffline(true);
      await alice.page.waitForSelector('.conn[data-conn="offline"]', { timeout: 15_000 });
      await bob.page.waitForSelector('.conn[data-conn="offline"]', { timeout: 15_000 });
      await endOfDoc(alice.page);
      await alice.page.keyboard.type(' Edit from Alice.');
      await endOfDoc(bob.page);
      await bob.page.keyboard.type(' Edit from Bob.');
      await alice.page.waitForSelector('.state.offline, .state:has-text("Saved on this device")');
      await bob.page.waitForTimeout(500);
      assert.doesNotMatch(await textOf(alice.page), /Edit from Bob/);

      // an offline reload still shows what was typed (the page lives in IndexedDB)
      await alice.page.reload();
      await alice.page.waitForSelector('.ProseMirror.doc', { timeout: 30_000 });
      await waitText(alice.page, /Edit from Alice\./);

      await alice.ctx.setOffline(false);
      await bob.ctx.setOffline(false);
      await alice.page.waitForSelector('.conn[data-conn="live"]', { timeout: 60_000 });
      await bob.page.waitForSelector('.conn[data-conn="live"]', { timeout: 60_000 });
      for (const d of [alice, bob]) {
        await waitText(d.page, /Edit from Alice\./, 30_000);
        await waitText(d.page, /Edit from Bob\./, 30_000);
      }
      const merged = await textOf(alice.page);
      assert.equal(merged, await textOf(bob.page), 'both see the same page');
      assert.equal((merged.match(/Original text\./g) ?? []).length, 1, 'nothing is duplicated');

      // no conflict copy anywhere
      await alice.page.waitForTimeout(1500);
      for (const d of [alice, bob])
        assert.equal(
          await d.page.locator('app-tree-category .row.page:has-text("conflict copy")').count(),
          0,
        );
      const pages = (await api(alice.page, 'GET', `/api/notebooks/${notebookId}/tree`)).body.pages;
      assert.equal(pages.filter((p) => !p.deletedAt).length, 1, 'still one page');

      // a copy of what each device had was kept before the merge
      assert.ok(
        (await localSnapshots(bob.page)) >= 1,
        'a local snapshot exists on the device that came back',
      );
      // ... and it is in the Local history, where the person can put it back or add it as a new page
      await bob.page.goto(new URL('/app/history', bob.page.url()).href);
      const kept = bob.page.locator('[data-entry][data-entity="page"][data-reason="pre_merge"]');
      await kept.first().waitFor();
      assert.ok((await kept.count()) >= 1, 'the history lists the copy kept before the merge');
      assert.equal(await kept.first().locator('[data-act=add]').count(), 1);
      assert.equal(await kept.first().locator('[data-act=replace]').count(), 1);
      await alice.page.waitForFunction(
        () => /Saved(?! on this device)/.test(document.querySelector('.state')?.textContent ?? ''),
        null,
        { timeout: 30_000 },
      );
      await alice.page.waitForTimeout(800);
      const stored = await serverContent(alice.page, pageId);
      assert.ok(stored.includes('Edit from Alice.') && stored.includes('Edit from Bob.'));
      for (const d of [alice, bob]) await d.close();
    },
  );
});

describe('share-link editing', () => {
  test(
    'a person who joined through an edit link edits live with the owner; revoking the link stops their edits and shows the read-only state',
    T,
    async () => {
      const alice = await account('Alice Owner');
      const bob = await account('Bob Guest');
      const { notebookId, pageId } = await seed(alice, 'Start.');
      const link = await api(alice.page, 'POST', `/api/notebooks/${notebookId}/links`, {
        access: 'edit',
      });
      assert.equal(link.status, 201, JSON.stringify(link.body));
      const token = link.body.token;
      assert.equal((await api(bob.page, 'POST', '/api/links/join', { token })).status, 200);

      await open(alice, pageId);
      await open(bob, pageId);
      await waitText(bob.page, /Start\./);
      await endOfDoc(bob.page);
      await bob.page.keyboard.type(' Guest wrote this.');
      await waitText(alice.page, /Guest wrote this\./);
      await endOfDoc(alice.page);
      await alice.page.keyboard.type(' Owner replied.');
      await waitText(bob.page, /Owner replied\./);

      assert.equal(
        (await api(alice.page, 'DELETE', `/api/links/${link.body.link?.id ?? link.body.id}`))
          .status,
        204,
      );
      // the connection is closed at once: Bob is read-only (or the page is gone from his device) and his typing no longer reaches Alice
      await bob.page.waitForFunction(
        () =>
          document.querySelector('[data-read-only]') ||
          document.querySelector('.empty') ||
          document.querySelector('.ProseMirror.doc')?.getAttribute('contenteditable') === 'false',
        null,
        { timeout: 30_000 },
      );
      await bob.page.keyboard.type('after revoke').catch(() => undefined);
      await alice.page.waitForTimeout(1500);
      assert.doesNotMatch(await textOf(alice.page), /after revoke/);
      assert.doesNotMatch(await serverContent(alice.page, pageId), /after revoke/);
      for (const d of [alice, bob]) await d.close();
    },
  );
});
