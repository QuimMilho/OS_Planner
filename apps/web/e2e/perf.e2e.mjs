// End-to-end, phase 17 (section C): with the service worker warm, the app is usable again within 3 seconds of opening it.
// The real app in real Chrome against the real server.
//   npm run e2e          (needs `docker compose up -d mysql mailpit` and a build)
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { launch, register, startStack, verify, waitForOfflineReady } from './harness.mjs';

const T = { timeout: 300_000 };
let stack;
let browser;

before(async () => {
  stack = await startStack();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await stack?.stop();
});

describe('start-up', () => {
  test(
    'a returning person with the app cached sees their notes in under 3 seconds',
    T,
    async () => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      const { email } = await register(page, stack.baseUrl, { name: 'Quick Start' });
      await verify(page, email);
      await page.goto(`${stack.baseUrl}/app`);
      await page.waitForSelector('app-rail');
      await waitForOfflineReady(page);
      const times = [];
      for (let i = 0; i < 3; i++) {
        const started = Date.now();
        await page.goto(`${stack.baseUrl}/app`);
        await page.waitForSelector('app-rail');
        await page.waitForSelector('app-shell main, app-shell [role=main], app-shell .content', {
          state: 'attached',
        });
        times.push(Date.now() - started);
      }
      const best = Math.min(...times);
      const worst = Math.max(...times);
      console.log(`cold start with a warm service worker: ${times.join(' / ')} ms`);
      // what the first load fetched before the app ran: the initial bundle only
      const initial = await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .filter((r) => /\/(main|polyfills|styles)-[A-Z0-9]+\.(js|css)$/i.test(r.name))
          .map((r) => r.name.split('/').pop()),
      );
      assert.ok(initial.length >= 1, 'the initial files were loaded');
      assert.ok(
        worst < 3000,
        `started within 3 s each time (${times.join(', ')} ms; best ${best})`,
      );
      await ctx.close();
    },
  );
});
