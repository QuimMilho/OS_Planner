#!/usr/bin/env node
// Soak test of phase 17: churn for a long time (people come and go, connections drop and storm back, rooms are joined and
// left, people join and leave the team), then check that nothing stayed behind: memory, sockets, rooms, timers.
//
//   node scripts/load/soak.mjs --minutes=1440      the 24-hour run of the plan
//   node scripts/load/soak.mjs --minutes=10        a short one
//
// Needs MySQL (`npm run db:up`) and a built server (`npm run build`). Prints the samples and the verdict; exit 1 on a leak.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  accounts,
  admin,
  api,
  metrics,
  requireFromServer,
  sleep,
  startServer,
  team,
  uuidv7,
  ROOT,
} from './lib.mjs';

const minutes = Number(process.argv.find((a) => a.startsWith('--minutes='))?.split('=')[1] ?? 10);
const people = Number(process.argv.find((a) => a.startsWith('--people='))?.split('=')[1] ?? 60);
const { io } = requireFromServer('socket.io-client');

const server = await startServer();
const root = await admin(server.baseUrl);
const [owner, ...crowd] = await accounts(server.baseUrl, people + 1, 'soak');
const t = await team(server.baseUrl, root, owner, crowd);
await api(server.baseUrl, owner.token)
  .patch(`/api/teams/${t.id}`, { isPublic: true, joinPolicy: 'open' })
  .catch(() =>
    api(server.baseUrl, owner.token).patch(`/api/teams/${t.id}`, {
      isPublic: true,
      joinPolicy: 'anyone',
    }),
  );
const channels = [];
for (let i = 0; i < 5; i++)
  channels.push(
    (
      await api(server.baseUrl, owner.token).post(`/api/spaces/${t.spaceId}/channels`, {
        name: `c${i}`,
      })
    ).id,
  );

const sockets = new Map(); // person id -> sockets
const connect = (who) =>
  new Promise((resolveConnect) => {
    const s = io(server.baseUrl, {
      path: '/api/realtime',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token: who.token },
    });
    const done = () => resolveConnect(s);
    s.once('connect', done);
    s.once('connect_error', done);
    const list = sockets.get(who.id) ?? [];
    list.push(s);
    sockets.set(who.id, list);
  });
const dropAll = () => {
  for (const list of sockets.values()) for (const s of list) s.disconnect();
  sockets.clear();
};
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const gc = async () => {
  await fetch(`${server.baseUrl}/api/metrics?gc=1`, {
    headers: { Authorization: `Bearer ${root.token}` },
  });
  await sleep(500);
  return metrics(server.baseUrl, root.token);
};

const samples = [];
const record = async (phase) => {
  const m = await metrics(server.baseUrl, root.token);
  const row = {
    at: new Date().toISOString(),
    phase,
    heapMb: Math.round(m.nodejs_heap_size_used_bytes / 1e5) / 10,
    rssMb: Math.round(m.process_resident_memory_bytes / 1e5) / 10,
    sockets: m.os_planner_realtime_sockets,
    rooms: m.os_planner_realtime_rooms,
    timers: m['nodejs_active_resources{type="Timeout"}'] ?? 0,
  };
  samples.push(row);
  console.log(JSON.stringify(row));
};

// warm up, then the baseline: everybody gone, after a garbage collection
for (const who of crowd.slice(0, 20)) await connect(who);
await sleep(2000);
dropAll();
await sleep(3000);
const base = await gc();
await record('baseline');

const end = Date.now() + minutes * 60_000;
let tick = 0;
let lastSample = Date.now();
while (Date.now() < end) {
  tick++;
  const who = pick(crowd);
  const r = Math.random();
  try {
    if (r < 0.35) await connect(who);
    else if (r < 0.55) {
      const list = sockets.get(who.id);
      list?.pop()?.disconnect();
    } else if (r < 0.75) {
      const s = sockets.get(who.id)?.at(-1);
      if (s?.connected) {
        const id = pick(channels);
        s.emit('room:join', { kind: 'channel', id }, () => undefined);
        if (Math.random() < 0.5)
          setTimeout(() => s.emit('room:leave', { kind: 'channel', id }), 500);
      }
    } else if (r < 0.85)
      await api(server.baseUrl, who.token).post(`/api/channels/${pick(channels)}/messages`, {
        id: uuidv7(),
        content: `soak ${tick}`,
      });
    else if (r < 0.92) {
      // leave the team and come back
      await api(server.baseUrl, who.token).del(`/api/teams/${t.id}/members/me`);
      await api(server.baseUrl, who.token).post(`/api/teams/${t.id}/join`, {});
    } else if (r < 0.925) {
      // a reconnect storm: everybody drops and comes back at once
      const online = [...sockets.keys()];
      dropAll();
      await Promise.all(online.map((id) => connect(crowd.find((c) => c.id === id))));
    }
  } catch {
    // a refused action (a full connection count, joining twice) is part of the churn
  }
  if (Date.now() - lastSample > 30_000) {
    lastSample = Date.now();
    await record('churn');
  }
  await sleep(50);
}

dropAll();
await sleep(5000);
const after = await gc();
await record('after');
await server.stop();

const growth =
  (after.nodejs_heap_size_used_bytes - base.nodejs_heap_size_used_bytes) /
  base.nodejs_heap_size_used_bytes;
const verdict = {
  minutes,
  ticks: tick,
  heapGrowth: `${(growth * 100).toFixed(1)} %`,
  socketsLeft: after.os_planner_realtime_sockets,
  roomsLeft: after.os_planner_realtime_rooms,
  roomsAtStart: base.os_planner_realtime_rooms,
  timersLeft: after['nodejs_active_resources{type="Timeout"}'] ?? 0,
  timersAtStart: base['nodejs_active_resources{type="Timeout"}'] ?? 0,
};
const ok =
  growth < 0.2 &&
  verdict.socketsLeft === 0 &&
  verdict.roomsLeft <= verdict.roomsAtStart &&
  verdict.timersLeft <= verdict.timersAtStart + 5;
writeFileSync(
  resolve(ROOT, 'apps/server/.load-data/soak.json'),
  JSON.stringify({ verdict, ok, samples }, null, 2),
);
console.log(JSON.stringify({ ...verdict, ok }, null, 2));
process.exit(ok ? 0 : 1);
