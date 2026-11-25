import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Response } from 'supertest';
import { createTestApp, GOOD_PASSWORD, uniqueEmail, type TestApp } from './app.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.prisma.user.deleteMany();
  t.mail.sent = [];
});

const CSRF = { 'X-Requested-With': 'notes' };

const cookieHeader = (res: Response): string => {
  const raw = (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('notes_rt='));
  if (!raw) throw new Error('no refresh cookie in response');
  return raw.split(';')[0]!;
};

async function register(overrides: Record<string, unknown> = {}) {
  const email = uniqueEmail();
  const res = await t.http
    .post('/api/auth/register')
    .send({ email, password: GOOD_PASSWORD, displayName: 'Ana', ...overrides });
  return { email, res };
}

describe('registration', () => {
  it('creates an account, returns an access token and sets a hardened refresh cookie', async () => {
    const { email, res } = await register();
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.expiresIn).toBe(900);
    expect(res.body.user).toMatchObject({ email, displayName: 'Ana', emailVerified: false, locale: 'en' });
    expect(res.body.user.passwordHash).toBeUndefined();

    const raw = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('notes_rt='))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\/api\/auth/);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('stores only a hash of the refresh token and an argon2id password hash', async () => {
    const { email, res } = await register();
    const token = cookieHeader(res).split('=')[1]!;
    const rows = await t.prisma.refreshToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.tokenHash).not.toContain(token);
    const user = await t.prisma.user.findUnique({ where: { email } });
    expect(user!.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('sends a verification mail in the chosen language', async () => {
    const { email } = await register({ locale: 'pt' });
    // sent in the background; give it a tick
    await new Promise((r) => setTimeout(r, 50));
    const mail = t.mail.last('verify', email);
    expect(mail).toBeDefined();
    expect(mail!.locale).toBe('pt');
  });

  it('rejects a duplicate email regardless of case', async () => {
    const { email } = await register();
    const dup = await t.http
      .post('/api/auth/register')
      .send({ email: email.toUpperCase(), password: GOOD_PASSWORD, displayName: 'Other' });
    expect(dup.status).toBe(409);
  });

  it.each([
    ['too short', 'short'],
    ['too common', 'password123'],
    ['one repeated character', 'aaaaaaaaaaaa'],
  ])('rejects a password that is %s', async (_label, password) => {
    const { res } = await register({ password });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid email and an empty name', async () => {
    expect((await register({ email: 'not-an-email' })).res.status).toBe(400);
    expect((await register({ displayName: '   ' })).res.status).toBe(400);
  });
});

describe('login and access tokens', () => {
  it('logs in with correct credentials and the access token opens protected routes', async () => {
    const { email } = await register();
    const login = await t.http.post('/api/auth/login').send({ email, password: GOOD_PASSWORD });
    expect(login.status).toBe(200);
    const me = await t.http.get('/api/me').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);
  });

  it('treats the email case-insensitively', async () => {
    const { email } = await register();
    const login = await t.http.post('/api/auth/login').send({ email: email.toUpperCase(), password: GOOD_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const { email } = await register();
    const wrong = await t.http.post('/api/auth/login').send({ email, password: 'wrong-password-123' });
    const unknown = await t.http.post('/api/auth/login').send({ email: uniqueEmail('nobody'), password: 'wrong-password-123' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('rejects missing, malformed and forged bearer tokens', async () => {
    expect((await t.http.get('/api/me')).status).toBe(401);
    expect((await t.http.get('/api/me').set('Authorization', 'Bearer nonsense')).status).toBe(401);
    expect((await t.http.get('/api/me').set('Authorization', 'Basic abc')).status).toBe(401);
    // a media token must not be usable as an access token
    const { res } = await register();
    const media = await t.http.post('/api/auth/media-token').set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(media.status).toBe(200);
    expect((await t.http.get('/api/me').set('Authorization', `Bearer ${media.body.token}`)).status).toBe(401);
  });
});

describe('refresh token rotation', () => {
  it('requires the CSRF header', async () => {
    const { res } = await register();
    const noHeader = await t.http.post('/api/auth/refresh').set('Cookie', cookieHeader(res));
    expect(noHeader.status).toBe(403);
  });

  it('rejects a request without a cookie', async () => {
    const res = await t.http.post('/api/auth/refresh').set(CSRF);
    expect(res.status).toBe(401);
  });

  it('rotates the token and issues a new access token', async () => {
    const { res } = await register();
    const first = cookieHeader(res);
    const refreshed = await t.http.post('/api/auth/refresh').set(CSRF).set('Cookie', first);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toEqual(expect.any(String));
    expect(cookieHeader(refreshed)).not.toBe(first);
    const me = await t.http.get('/api/me').set('Authorization', `Bearer ${refreshed.body.accessToken}`);
    expect(me.status).toBe(200);
  });

  it('treats an immediate replay as a tab race, not theft', async () => {
    const { res } = await register();
    const first = cookieHeader(res);
    const a = await t.http.post('/api/auth/refresh').set(CSRF).set('Cookie', first);
    const b = await t.http.post('/api/auth/refresh').set(CSRF).set('Cookie', first); // same old token
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // both resulting sessions keep working
    expect((await t.http.post('/api/auth/refresh').set(CSRF).set('Cookie', cookieHeader(a))).status).toBe(200);
    expect((await t.http.post('/api/auth/refresh').set(CSRF).set('Cookie', cookieHeader(b))).status).toBe(200);
  });

  it('revokes the whole family when a rotated token is replayed after the grace window', async () => {
    const { res } = await register();
    const stolen = cookieHeader(res);
    const rotated = await t.http.post('/api/auth/refresh').set(CSRF).set('Cookie', stolen);
    expect(rotated.status).toBe(200);

    // age the rotation past the grace window
    await t.prisma.refreshToken.updateMany({
      where: { replacedById: { not: null } },
      data: { revokedAt: new Date(Date.now() - 60_000) },
    });

    const replay = await t.http.post('/api/auth/refresh').set(CSRF).set('Cookie', stolen);
    expect(replay.status).toBe(401);
    // the legitimate holder of the newest token is signed out too
    const victim = await t.http.post('/api/auth/refresh').set(CSRF).set('Cookie', cookieHeader(rotated));
    expect(victim.status).toBe(401);
  });

  it('rejects an expired refresh token', async () => {
    const { res } = await register();
    await t.prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await t.http.post('/api/auth/refresh').set(CSRF).set('Cookie', cookieHeader(res));
    expect(r.status).toBe(401);
  });

  it('logout revokes the session and clears the cookie', async () => {
    const { res } = await register();
    const cookie = cookieHeader(res);
    const out = await t.http.post('/api/auth/logout').set(CSRF).set('Cookie', cookie);
    expect(out.status).toBe(204);
    expect((out.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(/notes_rt=;/);
    expect((await t.http.post('/api/auth/refresh').set(CSRF).set('Cookie', cookie)).status).toBe(401);
  });
});

describe('email verification', () => {
  it('verifies with the mailed token, and is idempotent', async () => {
    const { email, res } = await register();
    await new Promise((r) => setTimeout(r, 50));
    const token = t.mail.last('verify', email)!.token;

    const ok = await t.http.post('/api/auth/verify-email').send({ token });
    expect(ok.status).toBe(200);
    const me = await t.http.get('/api/me').set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(me.body.emailVerified).toBe(true);

    const again = await t.http.post('/api/auth/verify-email').send({ token });
    expect(again.status).toBe(200);
  });

  it('rejects unknown and expired tokens', async () => {
    const { email } = await register();
    await new Promise((r) => setTimeout(r, 50));
    expect((await t.http.post('/api/auth/verify-email').send({ token: 'x'.repeat(43) })).status).toBe(400);

    const token = t.mail.last('verify', email)!.token;
    await t.prisma.emailToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await t.http.post('/api/auth/verify-email').send({ token })).status).toBe(400);
  });

  it('does not accept a reset token as a verification token', async () => {
    const { email } = await register();
    await t.http.post('/api/auth/forgot-password').send({ email });
    const reset = t.mail.last('reset', email)!.token;
    expect((await t.http.post('/api/auth/verify-email').send({ token: reset })).status).toBe(400);
  });
});

describe('password reset', () => {
  it('answers identically for known and unknown emails, and only mails real accounts', async () => {
    const { email } = await register();
    t.mail.sent = [];
    const known = await t.http.post('/api/auth/forgot-password').send({ email });
    const unknown = await t.http.post('/api/auth/forgot-password').send({ email: uniqueEmail('ghost') });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.mail.sent.filter((m) => m.kind === 'reset')).toHaveLength(1);
  });

  it('resets the password, signs out every session, and the token works once', async () => {
    const { email, res } = await register();
    const session = cookieHeader(res);
    await t.http.post('/api/auth/forgot-password').send({ email });
    await new Promise((r) => setTimeout(r, 50));
    const token = t.mail.last('reset', email)!.token;
    const newPassword = 'a brand new passphrase';

    const reset = await t.http.post('/api/auth/reset-password').send({ token, password: newPassword });
    expect(reset.status).toBe(200);

    expect((await t.http.post('/api/auth/login').send({ email, password: GOOD_PASSWORD })).status).toBe(401);
    expect((await t.http.post('/api/auth/login').send({ email, password: newPassword })).status).toBe(200);
    expect((await t.http.post('/api/auth/refresh').set(CSRF).set('Cookie', session)).status).toBe(401);
    expect((await t.http.post('/api/auth/reset-password').send({ token, password: 'yet another passphrase' })).status).toBe(400);
  });

  it('a newer reset request invalidates the older link', async () => {
    const { email } = await register();
    await t.http.post('/api/auth/forgot-password').send({ email });
    await new Promise((r) => setTimeout(r, 50));
    const first = t.mail.last('reset', email)!.token;
    // get past the resend cool-down, then ask again
    await t.prisma.emailToken.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });
    await t.http.post('/api/auth/forgot-password').send({ email });
    await new Promise((r) => setTimeout(r, 50));
    const second = t.mail.last('reset', email)!.token;
    expect(second).not.toBe(first);
    expect((await t.http.post('/api/auth/reset-password').send({ token: first, password: 'some new passphrase' })).status).toBe(400);
    expect((await t.http.post('/api/auth/reset-password').send({ token: second, password: 'some new passphrase' })).status).toBe(200);
  });

  it('refuses an expired token and a common password', async () => {
    const { email } = await register();
    await t.http.post('/api/auth/forgot-password').send({ email });
    await new Promise((r) => setTimeout(r, 50));
    const token = t.mail.last('reset', email)!.token;
    expect((await t.http.post('/api/auth/reset-password').send({ token, password: 'password123' })).status).toBe(400);
    await t.prisma.emailToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await t.http.post('/api/auth/reset-password').send({ token, password: 'a perfectly fine passphrase' })).status).toBe(400);
  });
});

describe('account settings', () => {
  it('updates profile fields and validates them', async () => {
    const { res } = await register();
    const auth = { Authorization: `Bearer ${res.body.accessToken}` };
    const upd = await t.http.patch('/api/me').set(auth).send({ displayName: 'Beatriz', locale: 'pt', theme: 'dark' });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ displayName: 'Beatriz', locale: 'pt', theme: 'dark' });
    expect((await t.http.patch('/api/me').set(auth).send({ locale: 'fr' })).status).toBe(400);
    // cannot touch fields that are not part of the profile
    await t.http.patch('/api/me').set(auth).send({ emailVerifiedAt: new Date().toISOString(), email: 'x@y.zz' });
    const me = await t.http.get('/api/me').set(auth);
    expect(me.body.emailVerified).toBe(false);
    expect(me.body.email).not.toBe('x@y.zz');
  });

  it('stores each of the eight themes on the account, returns it on GET /api/me and rejects anything else', async () => {
    const { res } = await register();
    const auth = { Authorization: `Bearer ${res.body.accessToken}` };
    expect(res.body.user.theme).toBe('system'); // the default for a new account
    for (const theme of ['system', 'light', 'dark', 'purple', 'red', 'green', 'blue', 'darkblue']) {
      const upd = await t.http.patch('/api/me').set(auth).send({ theme });
      expect(upd.status, theme).toBe(200);
      expect(upd.body.theme).toBe(theme);
      expect((await t.http.get('/api/me').set(auth)).body.theme).toBe(theme);
    }
    // a rejected value changes nothing
    for (const bad of ['neon', 'Purple', '', 'darkblue!!', 7, null]) {
      expect((await t.http.patch('/api/me').set(auth).send({ theme: bad })).status, String(bad)).toBe(400);
    }
    expect((await t.http.get('/api/me').set(auth)).body.theme).toBe('darkblue');
  });

  it('changing the password keeps this session and signs out the others', async () => {
    const { email, res } = await register();
    const here = cookieHeader(res);
    const other = await t.http.post('/api/auth/login').send({ email, password: GOOD_PASSWORD });
    const auth = { Authorization: `Bearer ${res.body.accessToken}` };

    const wrong = await t.http.post('/api/me/password').set(auth).send({ currentPassword: 'nope-nope-nope', newPassword: 'a new passphrase here' });
    expect(wrong.status).toBe(401);

    const ok = await t.http.post('/api/me/password').set(auth).send({ currentPassword: GOOD_PASSWORD, newPassword: 'a new passphrase here' });
    expect(ok.status).toBe(204);
    expect((await t.http.post('/api/auth/refresh').set(CSRF).set('Cookie', here)).status).toBe(200);
    expect((await t.http.post('/api/auth/refresh').set(CSRF).set('Cookie', cookieHeader(other))).status).toBe(401);
  });

  it('lists sessions, marks the current one, and revokes another', async () => {
    const { email, res } = await register();
    const second = await t.http.post('/api/auth/login').send({ email, password: GOOD_PASSWORD });
    const auth = { Authorization: `Bearer ${res.body.accessToken}` };

    const list = await t.http.get('/api/me/sessions').set(auth);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);

    const other = list.body.find((s: { current: boolean }) => !s.current);
    expect((await t.http.delete(`/api/me/sessions/${other.id}`).set(auth)).status).toBe(204);
    expect((await t.http.post('/api/auth/refresh').set(CSRF).set('Cookie', cookieHeader(second))).status).toBe(401);
    expect((await t.http.get('/api/me/sessions').set(auth)).body).toHaveLength(1);
  });

  it("cannot revoke another user's session", async () => {
    const a = await register();
    const b = await register();
    const bSessions = await t.http.get('/api/me/sessions').set('Authorization', `Bearer ${b.res.body.accessToken}`);
    await t.http.delete(`/api/me/sessions/${bSessions.body[0].id}`).set('Authorization', `Bearer ${a.res.body.accessToken}`);
    const after = await t.http.get('/api/me/sessions').set('Authorization', `Bearer ${b.res.body.accessToken}`);
    expect(after.body).toHaveLength(1);
  });
});

describe('security headers', () => {
  it('sets a strict CSP and hides the framework', async () => {
    const res = await t.http.get('/api/me');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
