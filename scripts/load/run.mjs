#!/usr/bin/env node
// Load profiles of phase 17 (section C). Each starts from a fresh database, measures, and compares with its budget.
//
//   node scripts/load/run.mjs                 every profile at full size
//   node scripts/load/run.mjs fanout collab   only these
//   node scripts/load/run.mjs --scale=0.2     a fifth of the sizes (a quick run)
//
// Needs MySQL (`npm run db:up`) and a built server (`npm run build`). Writes apps/server/.load-data/results.json and prints a table.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { positionBetween } from '@os-planner/shared/lite';
import {
  accounts,
  admin,
  api,
  metrics,
  pool,
  requireFromServer,
  sleep,
  startServer,
  summary,
  team,
  uuid,
  uuidv7,
  ROOT,
} from './lib.mjs';

/** n valid positions in order (fractional indexing, like the app makes them). */
const positions = (n) => {
  const out = [];
  let last = null;
  for (let i = 0; i < n; i++) out.push((last = positionBetween(last, null)));
  return out;
};

const args = process.argv.slice(2);
const scale = Number(args.find((a) => a.startsWith('--scale='))?.split('=')[1] ?? 1);
const only = args.filter((a) => !a.startsWith('--'));
const S = (n) => Math.max(1, Math.round(n * scale));

const { io } = requireFromServer('socket.io-client');
const Y = requireFromServer('yjs');
const WebSocket = requireFromServer('ws');
const { HocuspocusProvider } = requireFromServer('@hocuspocus/provider');

const connectSocket = (baseUrl, token) =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    const socket = io(baseUrl, {
      path: '/api/realtime',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token },
    });
    socket.once('connect', () => resolve({ socket, ms: performance.now() - started }));
    socket.once('connect_error', reject);
  });
const ack = (socket, event, payload) =>
  new Promise((r) =>
    socket.timeout(10_000).emit(event, payload, (err, res) => r(err ? { ok: false } : res)),
  );

const profiles = {
  /** 2 000 connections at once (four per person), then all of them gone again: nothing may stay behind. */
  async sockets(server, root) {
    const people = await accounts(server.baseUrl, S(500), 'sock');
    const before = await metrics(server.baseUrl, root.token);
    const tokens = people.flatMap((p) => [p.token, p.token, p.token, p.token]);
    const open = await pool(tokens, 100, (token) => connectSocket(server.baseUrl, token));
    const during = await metrics(server.baseUrl, root.token);
    for (const { socket } of open) socket.disconnect();
    await sleep(3000);
    const after = await metrics(server.baseUrl, root.token);
    return {
      budget: 'all connect; sockets and rooms back to where they were',
      connect: summary(open.map((o) => o.ms)),
      sockets: {
        during: during.os_planner_realtime_sockets,
        after: after.os_planner_realtime_sockets,
      },
      rooms: { before: before.os_planner_realtime_rooms, after: after.os_planner_realtime_rooms },
      rssMb: {
        before: Math.round(before.process_resident_memory_bytes / 1e6),
        during: Math.round(during.process_resident_memory_bytes / 1e6),
      },
      pass:
        during.os_planner_realtime_sockets >= tokens.length &&
        after.os_planner_realtime_sockets === 0 &&
        after.os_planner_realtime_rooms <= before.os_planner_realtime_rooms,
    };
  },

  /** An @everyone message in a team of 1 000, 500 of them connected: how long until each sees it. */
  async fanout(server, root) {
    const [owner, ...members] = await accounts(server.baseUrl, S(1000) + 1, 'fan');
    const t = await team(server.baseUrl, root, owner, members);
    const channel = await api(server.baseUrl, owner.token).post(
      `/api/spaces/${t.spaceId}/channels`,
      { name: 'all' },
    );
    const listeners = await pool(members.slice(0, S(500)), 50, async (m) => {
      const { socket } = await connectSocket(server.baseUrl, m.token);
      await ack(socket, 'room:join', { kind: 'channel', id: channel.id });
      return socket;
    });
    const latencies = [];
    const posts = [];
    for (let round = 0; round < 5; round++) {
      const got = listeners.map(
        (s) =>
          new Promise((r) => {
            const timer = setTimeout(() => r(null), 15_000);
            s.once('message.created', () => (clearTimeout(timer), r(performance.now())));
          }),
      );
      const started = performance.now();
      await api(server.baseUrl, owner.token).post(`/api/channels/${channel.id}/messages`, {
        id: uuidv7(),
        content: `@everyone round ${round}`,
      });
      posts.push(performance.now() - started);
      for (const at of await Promise.all(got)) latencies.push(at === null ? 15_000 : at - started);
      await sleep(500);
    }
    for (const s of listeners) s.disconnect();
    const fan = summary(latencies);
    return {
      budget: 'fan-out p95 < 500 ms to 500 connected members',
      delivery: fan,
      send: summary(posts),
      pass: fan.p95 < 500,
    };
  },

  /** 100 people editing 20 pages (five on each): how long an edit takes to reach the others. */
  async collab(server, root) {
    const [owner, ...editors] = await accounts(server.baseUrl, S(100) + 1, 'co');
    const t = await team(server.baseUrl, root, owner, editors);
    const roles = await api(server.baseUrl, owner.token).get(`/api/teams/${t.id}/roles`);
    const everyone = roles.find((r) => r.isEveryone);
    await api(server.baseUrl, owner.token).patch(`/api/roles/${everyone.id}`, {
      permissions: String(BigInt(everyone.permissions) | (1n << 19n)),
    }); // + EDIT_PAGES
    const notebook = uuid();
    await api(server.baseUrl, owner.token).post('/api/notebooks', {
      id: notebook,
      spaceId: t.spaceId,
      name: 'Load',
      position: 'a0',
    });
    const tree = await api(server.baseUrl, owner.token).get(`/api/notebooks/${notebook}/tree`);
    const category = tree.categories[0].id;
    const pages = [];
    const pageCount = Math.max(1, Math.min(20, Math.floor(editors.length / 5)));
    const pos = positions(pageCount);
    for (let i = 0; i < pageCount; i++) {
      const id = uuid();
      await api(server.baseUrl, owner.token).post('/api/pages', {
        id,
        categoryId: category,
        title: `Page ${i}`,
        position: pos[i],
      });
      pages.push(id);
    }
    const url = `${server.baseUrl.replace(/^http/, 'ws')}/api/collab`;
    const latencies = [];
    const clients = await pool(editors, 20, async (who, i) => {
      const doc = new Y.Doc();
      const probe = doc.getMap('loadProbe');
      probe.observe((e) => {
        if (e.transaction.local) return;
        for (const key of e.keysChanged) {
          const sent = probe.get(key);
          if (typeof sent === 'number') latencies.push(Date.now() - sent);
        }
      });
      const provider = new HocuspocusProvider({
        url,
        name: pages[i % pages.length],
        document: doc,
        token: who.token,
        WebSocketPolyfill: WebSocket,
      });
      await new Promise((r, j) => {
        const timer = setTimeout(() => j(new Error('collab sync timed out')), 20_000);
        provider.on('synced', () => (clearTimeout(timer), r()));
      });
      return { provider, probe, id: who.id };
    });
    for (let round = 0; round < 10; round++) {
      for (const c of clients) c.probe.set(`${c.id}:${round}`, Date.now());
      await sleep(300);
    }
    await sleep(2000);
    for (const c of clients) c.provider.destroy();
    const s = summary(latencies);
    return {
      budget: 'update propagation p95 < 300 ms',
      pages: pages.length,
      editors: editors.length,
      propagation: s,
      pass: s.p95 < 300 && latencies.length > 0,
    };
  },

  /** 50 syncs at once of somebody with five spaces (a personal one, a team and three projects, 1 000 pages in all). */
  async sync(server, root) {
    const [owner] = await accounts(server.baseUrl, 1, 'sync');
    const t = await team(server.baseUrl, root, owner, []);
    const spaces = [null, t.spaceId];
    const projectPos = positions(3);
    for (let i = 0; i < 3; i++)
      spaces.push(
        (
          await api(server.baseUrl, owner.token).post(`/api/teams/${t.id}/projects`, {
            name: `P${i}`,
            position: projectPos[i],
          })
        ).spaceId,
      );
    for (const spaceId of spaces) {
      const ops = [];
      const pos = positions(10);
      for (let n = 0; n < S(5); n++) {
        const nb = uuid();
        ops.push({
          opId: uuid(),
          type: 'notebook.create',
          id: nb,
          ...(spaceId ? { spaceId } : {}),
          name: `N${n}`,
          position: positions(n + 1)[n],
        });
        for (let c = 0; c < 4; c++) {
          const cat = uuid();
          ops.push({
            opId: uuid(),
            type: 'category.create',
            id: cat,
            notebookId: nb,
            name: `C${c}`,
            position: pos[c],
          });
          for (let p = 0; p < 10; p++)
            ops.push({
              opId: uuid(),
              type: 'page.create',
              id: uuid(),
              categoryId: cat,
              title: `P${p}`,
              position: pos[p],
            });
        }
      }
      for (let i = 0; i < ops.length; i += 200)
        await api(server.baseUrl, owner.token).post('/api/sync/batch', {
          ops: ops.slice(i, i + 200),
        });
    }
    const me = await api(server.baseUrl, owner.token).get('/api/me');
    const cursors = Object.fromEntries([me.personalSpaceId, ...spaces.slice(1)].map((s) => [s, 0]));
    const oneSync = async () => {
      const started = performance.now();
      let more = true;
      const c = { ...cursors };
      while (more) {
        const res = await api(server.baseUrl, owner.token).get(
          `/api/sync/changes?cursors=${encodeURIComponent(JSON.stringify(c))}`,
        );
        more = Object.values(res.spaces).some((x) => x.hasMore);
        for (const [k, v] of Object.entries(res.spaces)) c[k] = v.cursor;
      }
      return performance.now() - started;
    };
    const alone = [];
    for (let i = 0; i < 10; i++) alone.push(await oneSync());
    const times = await pool(
      Array.from({ length: 50 }, (_, i) => i),
      50,
      async () => {
        const started = performance.now();
        let more = true;
        const c = { ...cursors };
        while (more) {
          const res = await api(server.baseUrl, owner.token).get(
            `/api/sync/changes?cursors=${encodeURIComponent(JSON.stringify(c))}`,
          );
          more = Object.values(res.spaces).some((x) => x.hasMore);
          for (const [k, v] of Object.entries(res.spaces)) c[k] = v.cursor;
        }
        return performance.now() - started;
      },
    );
    const s = summary(times);
    return {
      budget: 'a full first sync of 5 spaces (1 000 pages) alone; 50 at once recorded',
      alone: summary(alone),
      fiftyAtOnce: s,
      pass: true,
    };
  },

  /** A calendar of 500 weekly meetings, read for a whole year. */
  async calendar(server, root) {
    const [owner] = await accounts(server.baseUrl, 1, 'cal');
    const t = await team(server.baseUrl, root, owner, []);
    const start = Date.UTC(2026, 0, 5, 9, 0, 0);
    await pool(
      Array.from({ length: S(500) }, (_, i) => i),
      10,
      (i) =>
        api(server.baseUrl, owner.token).post('/api/events', {
          id: uuid(),
          spaceId: t.spaceId,
          title: `Weekly ${i}`,
          kind: 'meeting',
          startAt: new Date(start + (i % 7) * 86_400_000 + (i % 9) * 3_600_000).toISOString(),
          endAt: new Date(
            start + (i % 7) * 86_400_000 + (i % 9) * 3_600_000 + 1_800_000,
          ).toISOString(),
          timezone: 'Europe/Lisbon',
          rrule: 'FREQ=WEEKLY',
        }),
    );
    const times = [];
    let occurrences = 0;
    for (let i = 0; i < 20; i++) {
      const started = performance.now();
      const res = await api(server.baseUrl, owner.token).get(
        `/api/calendar?from=2026-01-01T00:00:00.000Z&to=2026-12-31T00:00:00.000Z&include=meetings`,
      );
      times.push(performance.now() - started);
      occurrences = res.items?.length ?? res.occurrences?.length ?? occurrences;
    }
    const s = summary(times);
    return {
      budget: 'a year of 500 recurring meetings: p95 < 200 ms',
      read: s,
      occurrences,
      pass: s.p95 < 200,
    };
  },

  /** 1 000 calendar apps each fetching their person's feed. */
  async feeds(server) {
    const people = await accounts(server.baseUrl, S(1000), 'feed');
    const urls = await pool(
      people,
      20,
      async (p) =>
        (await api(server.baseUrl, p.token).post('/api/me/feeds', { name: 'Phone' })).url,
    );
    const fetchOne = async (u) => {
      const started = performance.now();
      const res = await fetch(`${server.baseUrl}${new URL(u).pathname}`);
      await res.text();
      if (!res.ok) throw new Error(`feed ${res.status}`);
      return performance.now() - started;
    };
    const single = [];
    for (const u of urls.slice(0, 100)) single.push(await fetchOne(u));
    const started = Date.now();
    const burst = await pool(urls, 20, fetchOne);
    const seconds = (Date.now() - started) / 1000;
    const s = summary(single);
    return {
      budget: 'a feed fetch p95 < 200 ms; all 1 000 apps at once answered (recorded)',
      oneAtATime: s,
      burst: {
        ...summary(burst),
        perSecond: Math.round(urls.length / seconds),
        seconds: Math.round(seconds * 10) / 10,
      },
      pass: s.p95 < 200,
    };
  },

  /** The everyday reads of a member of a busy team, one at a time. */
  async reads(server, root) {
    const [owner, ...members] = await accounts(server.baseUrl, 201, 'read');
    const t = await team(server.baseUrl, root, owner, members);
    const o = api(server.baseUrl, owner.token);
    const channel = await o.post(`/api/spaces/${t.spaceId}/channels`, { name: 'general' });
    for (let i = 0; i < S(500); i++)
      await o.post(`/api/channels/${channel.id}/messages`, {
        id: uuidv7(),
        content: `message ${i} about the load test`,
      });
    const board = uuid();
    await o.post(`/api/spaces/${t.spaceId}/boards`, { id: board, name: 'Board', position: 'a0' });
    const detail = await o.get(`/api/boards/${board}`);
    const taskPos = positions(S(200));
    await pool(
      Array.from({ length: S(200) }, (_, i) => i),
      10,
      (i) =>
        o.post(`/api/boards/${board}/tasks`, {
          id: uuid(),
          columnId: detail.columns[i % 3].id,
          position: taskPos[i],
          title: `Task ${i}`,
        }),
    );
    const reader = api(server.baseUrl, members[0].token);
    const routes = {
      me: '/api/me',
      teams: '/api/teams',
      channels: `/api/teams/${t.id}/channels`,
      messages: `/api/channels/${channel.id}/messages`,
      board: `/api/boards/${board}`,
      notifications: '/api/notifications',
      unread: `/api/teams/${t.id}/unread`,
      search: '/api/search?q=load',
    };
    const out = {};
    let worst = 0;
    for (const [name, path] of Object.entries(routes)) {
      const times = [];
      for (let i = 0; i < 50; i++) {
        const started = performance.now();
        await reader.get(path);
        times.push(performance.now() - started);
      }
      out[name] = summary(times);
      worst = Math.max(worst, out[name].p95);
    }
    return { budget: 'API reads p95 < 200 ms', ...out, pass: worst < 200 };
  },
};

const chosen = only.length ? only : Object.keys(profiles);
const results = {};
for (const name of chosen) {
  if (!profiles[name])
    throw new Error(`unknown profile ${name}; known: ${Object.keys(profiles).join(', ')}`);
  process.stdout.write(`${name}... `);
  const server = await startServer();
  try {
    const root = await admin(server.baseUrl);
    const started = Date.now();
    results[name] = {
      ...(await profiles[name](server, root)),
      seconds: Math.round((Date.now() - started) / 1000),
    };
    console.log(results[name].pass ? 'ok' : 'OVER BUDGET');
  } catch (e) {
    results[name] = { error: e instanceof Error ? e.message : String(e), pass: false };
    console.log(`failed: ${results[name].error}\n${server.log().slice(-2000)}`);
  } finally {
    await server.stop();
  }
}
const file = resolve(ROOT, 'apps/server/.load-data/results.json');
writeFileSync(file, JSON.stringify({ scale, at: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify(results, null, 2));
console.log(`\nwritten to ${file}`);
process.exit(Object.values(results).every((r) => r.pass) ? 0 : 1);
