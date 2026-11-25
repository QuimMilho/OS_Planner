// End-to-end: colour themes. The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { apiGet, launch, login, register, startStack } from './harness.mjs';

const T = { timeout: 120_000 };
const THEMES = ['light', 'dark', 'purple', 'red', 'green', 'blue', 'darkblue'];
const DARK = ['dark', 'purple', 'red', 'green', 'blue', 'darkblue'];

let stack;
let browser;
let base;

before(async () => {
  stack = await startStack();
  base = stack.baseUrl;
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await stack?.stop();
});

async function device(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...options });
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

/** What the page looks like to a person: the resolved page and accent colours, and the `data-theme` attribute. */
const look = (page) =>
  page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.documentElement.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return {
      attr: document.documentElement.getAttribute('data-theme'),
      background: getComputedStyle(document.body).backgroundColor,
      accent,
      scheme: getComputedStyle(document.documentElement).colorScheme,
      metaColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'),
    };
  });

const luminance = (rgb) => {
  const [r, g, b] = /(\d+)[, ]+(\d+)[, ]+(\d+)/.exec(rgb).slice(1).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

const openSettings = async (page) => {
  await page.goto(`${base}/app/settings`);
  await page.waitForSelector('.theme[data-pick]');
};
const pick = async (page, id) => {
  await page.click(`.theme[data-pick="${id}"]`);
  await page.waitForFunction(
    (x) =>
      x === 'system'
        ? !document.documentElement.hasAttribute('data-theme')
        : document.documentElement.getAttribute('data-theme') === x,
    id,
  );
};
const accountTheme = async (page) => (await apiGet(page, '/api/me')).body.theme;

describe('themes', () => {
  test(
    'with no choice the operating system decides: dark OS is dark, light OS is light, and no data-theme is set',
    T,
    async () => {
      for (const scheme of ['dark', 'light']) {
        const { page, close } = await device({ colorScheme: scheme });
        await page.goto(`${base}/login`);
        await page.waitForSelector('input[name=email]');
        const l = await look(page);
        assert.equal(l.attr, null, `${scheme}: no attribute`);
        assert.equal(
          luminance(l.background) < 0.5,
          scheme === 'dark',
          `${scheme} OS: the page background is ${l.background}`,
        );
        await close();
      }
    },
  );

  test(
    'each of the seven themes sets data-theme, changes the accent, is saved to the account and survives a reload',
    T,
    async () => {
      const { page, problems, close } = await device({ colorScheme: 'light' });
      await register(page, base);
      await openSettings(page);
      assert.equal(
        await page.locator('.theme[role=radio]').count(),
        8,
        'seven themes and "same as device"',
      );
      assert.equal(
        await page.getAttribute('.theme.on', 'data-pick'),
        'system',
        'new accounts follow the device',
      );

      const accents = new Map();
      for (const id of THEMES) {
        await pick(page, id);
        const l = await look(page);
        assert.equal(l.attr, id);
        assert.equal(l.scheme, DARK.includes(id) ? 'dark' : 'light', `${id}: colour scheme`);
        assert.equal(
          luminance(l.background) < 0.35,
          DARK.includes(id),
          `${id}: background ${l.background}`,
        );
        assert.ok(!accents.has(l.accent), `${id} has the same accent as ${accents.get(l.accent)}`);
        accents.set(l.accent, id);
        assert.equal(
          await page.getAttribute('.theme.on', 'data-pick'),
          id,
          'the picker marks the current theme',
        );
        assert.equal(await page.getAttribute('.theme.on', 'aria-checked'), 'true');
        // saved on the account, and on this device for the next start
        await page.waitForFunction(
          async () => localStorage.getItem('notes.theme.pending') === null,
          null,
          { timeout: 10_000 },
        );
        assert.equal(await accountTheme(page), id);

        await page.reload();
        await page.waitForSelector('.theme[data-pick]');
        assert.equal((await look(page)).attr, id, `${id} survives a reload`);
        assert.equal(await page.getAttribute('.theme.on', 'data-pick'), id);
      }
      // the theme-colour of the browser chrome follows the page
      assert.match((await look(page)).metaColor, /^#[0-9a-f]{6}$/);
      // back to "same as device"
      await pick(page, 'system');
      assert.equal(await accountTheme(page), 'system');
      assert.deepEqual(problems, [], 'nothing may be blocked by the Content-Security-Policy');
      await close();
    },
  );

  test('the picker works from the keyboard like a radio group', T, async () => {
    const { page, close } = await device({ colorScheme: 'light' });
    await register(page, base);
    await openSettings(page);
    await page.focus('.theme.on'); // "same as device" is current and is the one tab stop
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'light',
    );
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'dark',
    );
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(
      () => document.documentElement.getAttribute('data-theme') === 'light',
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute('data-pick')),
      'light',
      'focus follows the choice',
    );
    await close();
  });

  test(
    'a theme chosen on one device is applied on a fresh device straight after sign-in, with no frame of another theme',
    T,
    async () => {
      const a = await device({ colorScheme: 'light' });
      const { email } = await register(a.page, base);
      await openSettings(a.page);
      await pick(a.page, 'purple');
      await a.page.waitForFunction(() => localStorage.getItem('notes.theme.pending') === null);
      await a.close();

      const b = await device({ colorScheme: 'light' });
      // record every value `data-theme` ever takes, from before the app starts
      await b.page.addInitScript(() => {
        window.__themes = [];
        new MutationObserver((records) => {
          for (const r of records) window.__themes.push(r.target.getAttribute('data-theme'));
        }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-theme'] });
      });
      await login(b.page, base, email);
      assert.equal((await look(b.page)).attr, 'purple');
      assert.deepEqual(
        await b.page.evaluate(() => window.__themes),
        ['purple'],
        'the first (and only) theme the page ever showed after signing in',
      );
      await b.close();
    },
  );

  test(
    '"same as device" follows a live switch of the operating system without a reload',
    T,
    async () => {
      const { page, close } = await device({ colorScheme: 'light' });
      await register(page, base);
      assert.equal((await look(page)).attr, null);
      assert.ok(luminance((await look(page)).background) > 0.5, 'light to begin with');
      const before = (await look(page)).metaColor;
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForFunction(
        () => getComputedStyle(document.body).backgroundColor !== 'rgb(250, 249, 253)',
      );
      await page
        .waitForFunction(
          (was) =>
            document.querySelector('meta[name="theme-color"]')?.getAttribute('content') !== was,
          before,
          { timeout: 5000 },
        )
        .catch(() => undefined);
      const dark = await look(page);
      assert.ok(
        luminance(dark.background) < 0.35,
        `dark after the OS switched: ${dark.background}`,
      );
      assert.notEqual(dark.metaColor, before, 'the browser chrome colour follows too');
      await page.emulateMedia({ colorScheme: 'light' });
      await page.waitForFunction(
        () => getComputedStyle(document.body).backgroundColor === 'rgb(250, 249, 253)',
      );
      assert.equal((await look(page)).attr, null);

      // a fixed theme does not follow the OS
      await openSettings(page);
      await pick(page, 'green');
      await page.emulateMedia({ colorScheme: 'light' });
      const green = await look(page);
      await page.emulateMedia({ colorScheme: 'dark' });
      assert.deepEqual(await look(page), green, 'green stays green');
      await close();
    },
  );

  test(
    'a theme chosen offline is kept on the device and sent to the account when the connection returns',
    T,
    async () => {
      const { ctx, page, close } = await device({ colorScheme: 'light' });
      await register(page, base);
      await openSettings(page);
      assert.equal(await accountTheme(page), 'system');

      await ctx.setOffline(true);
      await pick(page, 'red');
      assert.equal((await look(page)).attr, 'red', 'applied at once, even offline');
      assert.equal(await page.evaluate(() => localStorage.getItem('notes.theme')), 'red');
      await page.waitForFunction(() => localStorage.getItem('notes.theme.pending') === '1');

      await ctx.setOffline(false);
      await page.waitForFunction(() => localStorage.getItem('notes.theme.pending') === null, null, {
        timeout: 30_000,
      });
      assert.equal(await accountTheme(page), 'red', 'the account has the choice now');
      await close();
    },
  );

  test(
    'an offline choice survives closing the tab and is delivered at the next sign-in session',
    T,
    async () => {
      const { ctx, page, close } = await device({ colorScheme: 'light' });
      const { email } = await register(page, base);
      await openSettings(page);
      await ctx.setOffline(true);
      await pick(page, 'blue');
      await ctx.setOffline(false);
      // closed before the browser noticed it was back online: the next visit delivers it
      await page.goto('about:blank');
      await page.goto(`${base}/app`);
      await page.waitForSelector('app-shell');
      await page.waitForFunction(() => localStorage.getItem('notes.theme.pending') === null, null, {
        timeout: 30_000,
      });
      assert.equal(await accountTheme(page), 'blue');
      assert.equal((await look(page)).attr, 'blue');
      void email;
      await close();
    },
  );

  test(
    'the account wins over a stale copy on this device when nothing is waiting to be sent',
    T,
    async () => {
      const a = await device({ colorScheme: 'light' });
      const { email } = await register(a.page, base);
      await openSettings(a.page);
      await pick(a.page, 'dark');
      await a.page.waitForFunction(() => localStorage.getItem('notes.theme.pending') === null);

      // another device changes it
      const b = await device({ colorScheme: 'light' });
      await login(b.page, base, email);
      await openSettings(b.page);
      await pick(b.page, 'green');
      await b.page.waitForFunction(() => localStorage.getItem('notes.theme.pending') === null);
      await b.close();

      // the first device signs in again (a new session read): it takes the account's value
      await a.page.goto(`${base}/app`);
      await a.page.waitForSelector('app-shell');
      await a.page.waitForFunction(
        () => document.documentElement.getAttribute('data-theme') === 'green',
      );
      await a.close();
    },
  );
});
