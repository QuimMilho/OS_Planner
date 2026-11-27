import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { COLLAB_PATH } from '@os-planner/shared';
import { yDocToJSON } from '@os-planner/shared/collab';
import { CollabServer } from '../src/collab/collab.server.js';
import { createTestApp, type TestApp } from './app.js';
import { builders, signup } from './helpers.js';

// Two server instances on one database and one Redis: the people on each of them are in the same page.
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const until = async (
  cond: () => boolean | Promise<boolean>,
  what: string,
  ms = 8000,
): Promise<void> => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('co-editing across server instances (needs Redis: docker compose --profile scale up -d redis)', () => {
  const apps: TestApp[] = [];
  const providers: HocuspocusProvider[] = [];
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const k of ['REDIS_URL', 'COLLAB_DEBOUNCE_MS', 'COLLAB_MAX_DEBOUNCE_MS'])
      saved[k] = process.env[k];
  });
  afterAll(async () => {
    for (const p of providers) p.destroy();
    for (const a of apps) await a.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('two people on different instances see each other, and the page is stored once', async () => {
    expect(await redisAvailable(), 'start Redis: docker compose --profile scale up -d redis').toBe(
      true,
    );
    process.env.REDIS_URL = REDIS_URL;
    process.env.COLLAB_DEBOUNCE_MS = '60';
    process.env.COLLAB_MAX_DEBOUNCE_MS = '300';
    const a = await createTestApp();
    const b = await createTestApp();
    apps.push(a, b);
    expect(a.app.get(CollabServer).usesRedis).toBe(true);
    const urlOf = async (t: TestApp) => {
      await t.app.listen(0, '127.0.0.1');
      return `ws://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}${COLLAB_PATH}`;
    };
    const [urlA, urlB] = [await urlOf(a), await urlOf(b)];

    const alice = await signup(a);
    const bobUser = await signup(a);
    const builder = builders(a, alice);
    const nb = await builder.notebook('Scale');
    const page = await builder.page((await builder.category(nb.id)).id, 'Scaled');
    // Bob needs access to the notebook: a share needs a verified account and a shared team for a user id, but an address works
    await a.http
      .put(`/api/notebooks/${nb.id}/shares`)
      .set(alice.auth)
      .send({ email: bobUser.email, access: 'edit' })
      .expect(200);

    const join = (url: string, token: string) => {
      const doc = new Y.Doc();
      const provider = new HocuspocusProvider({
        url,
        name: page.id,
        document: doc,
        token,
        WebSocketPolyfill: WebSocket as never,
      });
      providers.push(provider);
      return { doc, provider };
    };
    const onA = join(urlA, alice.token);
    const onB = join(urlB, bobUser.token);
    await until(() => onA.provider.synced && onB.provider.synced, 'both to sync');

    const type = (doc: Y.Doc, text: string) => {
      const f = doc.getXmlFragment('content');
      if (f.length === 0) {
        const p = new Y.XmlElement('paragraph');
        const x = new Y.XmlText();
        x.insert(0, text);
        p.insert(0, [x]);
        f.insert(0, [p]);
        return;
      }
      const x = (f.get(0) as Y.XmlElement).get(0) as Y.XmlText;
      x.insert(x.length, text);
    };
    type(onA.doc, 'from A');
    await until(
      () => JSON.stringify(yDocToJSON(onB.doc)).includes('from A'),
      'B to see A across Redis',
    );
    type(onB.doc, ' and B');
    await until(
      () => JSON.stringify(yDocToJSON(onA.doc)).includes('and B'),
      'A to see B across Redis',
    );
    await until(
      async () =>
        (await a.prisma.page.findUniqueOrThrow({ where: { id: page.id } })).contentText.includes(
          'and B',
        ),
      'the page to be stored',
    );
    expect(yDocToJSON(onA.doc)).toEqual(yDocToJSON(onB.doc));
  }, 60_000);
});
