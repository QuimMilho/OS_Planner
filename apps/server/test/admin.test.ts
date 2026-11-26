import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_PAGE } from '../src/admin/admin.service.js';
import { createTestApp, type TestApp } from './app.js';
import { signup, uuid, type Account } from './helpers.js';

const ADMIN_EMAIL = `Admin${Date.now()}@Example.com`; // mixed case on purpose: the setting is case-insensitive

let t: TestApp;
let saved: string | undefined;
let admin: Account;
let someone: Account;

beforeAll(async () => {
  saved = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = ` ${ADMIN_EMAIL}, nobody@example.com `;
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  if (saved === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = saved;
});
beforeEach(async () => {
  await t.prisma.quotaOverride.deleteMany();
  await t.prisma.team.deleteMany(); // other test files leave teams behind; the statistics count them
  await t.prisma.user.deleteMany();
  admin = await signup(t, true, ADMIN_EMAIL.toLowerCase());
  someone = await signup(t);
});

const adminRoutes = (id: string) =>
  [
    ['get', '/api/admin/users'],
    ['get', '/api/admin/stats'],
    ['get', `/api/admin/quotas/user/${id}`],
    ['put', `/api/admin/quotas/user/${id}`],
    ['delete', `/api/admin/quotas/user/${id}`],
  ] as const;

describe('who can reach /api/admin', () => {
  it('answers 404 to anonymous callers, ordinary users and admins whose address is not verified', async () => {
    // Listed in ADMIN_EMAILS, but nobody proved they own the address.
    const unverified = await signup(t, false, 'nobody@example.com');

    for (const [method, url] of adminRoutes(someone.id)) {
      const anon = await t.http[method](url).send({});
      expect(anon.status, `anonymous ${method} ${url}`).toBe(404);
      const bad = await t.http[method](url).set({ Authorization: 'Bearer nonsense' }).send({});
      expect(bad.status, `bad token ${method} ${url}`).toBe(404);
      const user = await t.http[method](url).set(someone.auth).send({});
      expect(user.status, `user ${method} ${url}`).toBe(404);
      const unv = await t.http[method](url).set(unverified.auth).send({});
      expect(unv.status, `unverified admin ${method} ${url}`).toBe(404);
    }
  });

  it('lets a verified admin in, whatever the case of the configured address', async () => {
    for (const [method, url] of adminRoutes(someone.id)) {
      const res = await t.http[method](url).set(admin.auth).send({});
      expect(res.status, `${method} ${url}`).toBe(200);
    }
  });

  it('reports isAdmin on /api/me only for a verified admin', async () => {
    expect((await t.http.get('/api/me').set(admin.auth)).body.isAdmin).toBe(true);
    expect((await t.http.get('/api/me').set(someone.auth)).body.isAdmin).toBe(false);
    await t.prisma.user.update({ where: { id: admin.id }, data: { emailVerifiedAt: null } });
    expect((await t.http.get('/api/me').set(admin.auth)).body.isAdmin).toBe(false);
  });

  it('leaves the release-publishing routes alone', async () => {
    // Guarded by RELEASE_TOKEN, not by this feature: still 404 without a configured token.
    const res = await t.http.post('/api/admin/releases').send({});
    expect([401, 404]).toContain(res.status);
  });
});

describe('user list', () => {
  it('searches by name or address and pages with a cursor', async () => {
    const found = await t.http
      .get('/api/admin/users')
      .query({ q: someone.email.slice(0, 12) })
      .set(admin.auth);
    expect(found.body.items.map((u: { id: string }) => u.id)).toContain(someone.id);

    const none = await t.http
      .get('/api/admin/users')
      .query({ q: 'no-such-person-anywhere' })
      .set(admin.auth);
    expect(none.body.items).toEqual([]);

    const size = ADMIN_PAGE.size;
    ADMIN_PAGE.size = 2;
    try {
      await signup(t);
      await signup(t);
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const res = await t.http
          .get('/api/admin/users')
          .query(cursor ? { cursor } : {})
          .set(admin.auth);
        expect(res.status).toBe(200);
        expect(res.body.items.length).toBeLessThanOrEqual(2);
        seen.push(...res.body.items.map((u: { id: string }) => u.id));
        cursor = res.body.nextCursor ?? undefined;
        if (!cursor) break;
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen.length).toBe(4);
    } finally {
      ADMIN_PAGE.size = size;
    }
  });

  it('shows usage, limit and whether an override applies', async () => {
    await t.http
      .put(`/api/admin/quotas/user/${someone.id}`)
      .set(admin.auth)
      .send({ storageBytes: 12345 });
    const row = (await t.http.get('/api/admin/users').query({ q: someone.email }).set(admin.auth))
      .body.items[0];
    expect(row).toMatchObject({
      id: someone.id,
      limit: 12345,
      hasOverride: true,
      emailVerified: true,
    });
  });

  it('counts accounts and storage', async () => {
    const stats = (await t.http.get('/api/admin/stats').set(admin.auth)).body;
    expect(stats).toMatchObject({ users: 2, verifiedUsers: 2, teams: 0 });
  });
});

describe('quota overrides', () => {
  const put = (id: string, body: object) =>
    t.http.put(`/api/admin/quotas/user/${id}`).set(admin.auth).send(body);

  it('changes the limit the user sees without logging out, and clearing restores the default', async () => {
    const before = (await t.http.get('/api/me').set(someone.auth)).body.quota;
    expect(before).toMatchObject({ scope: 'user', used: 0 });

    const set = await put(someone.id, { storageBytes: 5_000_000, note: 'research project' });
    expect(set.status).toBe(200);
    expect(set.body.override).toMatchObject({
      storageBytes: 5_000_000,
      note: 'research project',
      updatedBy: admin.id,
    });
    expect(set.body.effective.storageBytes).toBe(5_000_000);
    expect(set.body.defaults.storageBytes).toBe(before.limit);

    expect((await t.http.get('/api/me').set(someone.auth)).body.quota.limit).toBe(5_000_000);

    const cleared = await t.http.delete(`/api/admin/quotas/user/${someone.id}`).set(admin.auth);
    expect(cleared.status).toBe(200);
    expect(cleared.body.override).toBeNull();
    expect((await t.http.get('/api/me').set(someone.auth)).body.quota.limit).toBe(before.limit);
  });

  it('leaves fields that are not set at their defaults', async () => {
    const res = await put(someone.id, { maxFileBytes: 1000 });
    expect(res.body.effective.storageBytes).toBe(res.body.defaults.storageBytes);
    expect(res.body.effective.maxFileBytes).toBe(1000);
  });

  it('rejects negative, fractional and absurd values', async () => {
    for (const body of [
      { storageBytes: -1 },
      { storageBytes: 1.5 },
      { storageBytes: Number.MAX_SAFE_INTEGER + 2 },
      { maxMembers: -3 },
      { note: 'x'.repeat(501) },
    ]) {
      expect((await put(someone.id, body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await put(someone.id, { storageBytes: Number.MAX_SAFE_INTEGER })).status).toBe(200);
  });

  it('404s for something that does not exist and 400s for a bad scope or id', async () => {
    expect((await put(uuid(), { storageBytes: 1 })).status).toBe(404);
    expect((await t.http.get(`/api/admin/quotas/user/${uuid()}`).set(admin.auth)).status).toBe(404);
    expect(
      (await t.http.get('/api/admin/quotas/galaxy/' + someone.id).set(admin.auth)).status,
    ).toBe(400);
    expect((await t.http.get('/api/admin/quotas/user/not-a-uuid').set(admin.auth)).status).toBe(
      400,
    );
  });
});
