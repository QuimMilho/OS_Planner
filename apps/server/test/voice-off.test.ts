import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './app.js';
import { signup } from './helpers.js';

const ADMIN_EMAIL = `voiceoff-admin${Date.now()}@example.com`;

let t: TestApp;
const keep: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of [
    'LIVEKIT_URL',
    'LIVEKIT_API_URL',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'ADMIN_EMAILS',
  ])
    keep[k] = process.env[k];
  for (const k of ['LIVEKIT_URL', 'LIVEKIT_API_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'])
    delete process.env[k];
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  for (const [k, v] of Object.entries(keep)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('voice switched off', () => {
  it('reports voice:false, and every voice route answers 404, 422 or 401', async () => {
    expect((await t.http.get('/api/features')).body).toMatchObject({ voice: false });
    const admin = await signup(t, true, ADMIN_EMAIL);
    const me = await signup(t);
    const res = await t.http
      .post('/api/admin/teams')
      .set(admin.auth)
      .send({ name: 'Quiet', ownerEmail: me.email });
    expect(res.status).toBe(201);
    const space = (await t.prisma.team.findUniqueOrThrow({ where: { id: res.body.id } })).spaceId;
    expect(
      (
        await t.http
          .post(`/api/spaces/${space}/channels`)
          .set(me.auth)
          .send({ name: 'v', kind: 'voice' })
      ).status,
    ).toBe(422);
    const text = await t.http
      .post(`/api/spaces/${space}/channels`)
      .set(me.auth)
      .send({ name: 'chat' });
    expect(
      (await t.http.post(`/api/channels/${text.body.id}/voice/token`).set(me.auth)).status,
    ).toBe(404);
    expect((await t.http.get(`/api/teams/${res.body.id}/voice`).set(me.auth)).status).toBe(404);
    expect(
      (
        await t.http
          .post('/api/voice/webhook')
          .set('Authorization', 'x')
          .set('Content-Type', 'application/webhook+json')
          .send('{}')
      ).status,
    ).toBe(401);
  });
});
