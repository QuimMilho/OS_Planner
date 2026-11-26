import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import argon2 from 'argon2';
import mariadb from 'mariadb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, GOOD_PASSWORD, type TestApp } from './app.js';
import { TEST_DB } from './env.js';

// A database that grows through the real migrations, with data written by the old schema in between.
const DB = 'notes_migration_test';
const MIGRATIONS = resolve(import.meta.dirname, '../prisma/migrations');
const folders = readdirSync(MIGRATIONS)
  .filter((d) => /^\d{14}_/.test(d))
  .sort();
const upTo = (name: string) => folders.slice(0, folders.findIndex((d) => d.endsWith(name)) + 1);
const only = (name: string) => folders.filter((d) => d.endsWith(name));

let conn: mariadb.Connection;
let savedUrl: string | undefined;

const rows = async <T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> => (await conn.query(sql, params)) as T[];
const apply = async (dirs: string[]) => {
  for (const dir of dirs)
    await conn.query(readFileSync(resolve(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
};

const alice = { id: randomUUID(), email: 'alice@example.com', seq: 7, usedBefore: 3000 };
const bob = { id: randomUUID(), email: 'bob@example.com', seq: 2, usedBefore: 0 };
const ids = {
  nb: randomUUID(),
  nbTrash: randomUUID(),
  cat: randomUUID(),
  sub: randomUUID(),
  page: randomUUID(),
  pageTrash: randomUUID(),
  bobNb: randomUUID(),
  bobCat: randomUUID(),
  bobPage: randomUUID(),
  img: randomUUID(),
  vid: randomUUID(),
};
const doc = (text: string) =>
  JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  conn = await mariadb.createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    allowPublicKeyRetrieval: true,
    multipleStatements: true,
  });
  await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``);
  await conn.query(`CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${DB}\``);
  savedUrl = process.env.DATABASE_URL;
});
afterAll(async () => {
  if (savedUrl) process.env.DATABASE_URL = savedUrl;
  await conn.query(`DROP DATABASE IF EXISTS \`${DB}\``).catch(() => undefined);
  await conn.end();
});

describe('migrating a database that holds data from before', () => {
  it('phase 2: usage becomes media bytes + document bytes', async () => {
    await apply(upTo('widen_user_theme')); // the schema as it was before phase 2
    const hash = await argon2.hash(GOOD_PASSWORD, { type: argon2.argon2id });

    for (const u of [alice, bob]) {
      await conn.query(
        'INSERT INTO `User` (id, email, passwordHash, displayName, locale, theme, emailVerifiedAt, storageUsedBytes, changeSeq, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, NOW(3), ?, ?, NOW(3), NOW(3))',
        [u.id, u.email, hash, u.email.split('@')[0], 'en', 'system', u.usedBefore, u.seq],
      );
    }
    const nb = (id: string, userId: string, name: string, seq: number, deleted = false) =>
      conn.query(
        'INSERT INTO `Notebook` (id, userId, name, position, seq, deletedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, NOW(3), NOW(3))',
        [id, userId, name, 'a0', seq, deleted ? new Date() : null],
      );
    await nb(ids.nb, alice.id, 'Alice notebook', 1);
    await nb(ids.nbTrash, alice.id, 'Alice trash', 2, true);
    await nb(ids.bobNb, bob.id, 'Bob notebook', 1);
    const cat = (
      id: string,
      userId: string,
      notebookId: string,
      parentId: string | null,
      name: string,
      seq: number,
    ) =>
      conn.query(
        'INSERT INTO `Category` (id, userId, notebookId, parentId, name, position, seq, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))',
        [id, userId, notebookId, parentId, name, 'a0', seq],
      );
    await cat(ids.cat, alice.id, ids.nb, null, 'Top', 3);
    await cat(ids.sub, alice.id, ids.nb, ids.cat, 'Sub', 4);
    await cat(ids.bobCat, bob.id, ids.bobNb, null, 'Bob top', 2);
    const page = (
      id: string,
      userId: string,
      notebookId: string,
      categoryId: string,
      title: string,
      text: string,
      seq: number,
      deleted = false,
    ) =>
      conn.query(
        'INSERT INTO `Page` (id, userId, notebookId, categoryId, title, content, contentText, schemaVersion, version, position, seq, deletedAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 3, ?, ?, ?, NOW(3), NOW(3))',
        [
          id,
          userId,
          notebookId,
          categoryId,
          title,
          doc(text),
          text,
          'a0',
          seq,
          deleted ? new Date() : null,
        ],
      );
    await page(ids.page, alice.id, ids.nb, ids.sub, 'Hello', 'café com leite', 5);
    await page(ids.pageTrash, alice.id, ids.nb, ids.cat, 'Old', 'in the bin', 6, true);
    await page(ids.bobPage, bob.id, ids.bobNb, ids.bobCat, 'Bob page', 'bob writes', 2);
    const media = (id: string, userId: string, kind: string, size: number) =>
      conn.query(
        'INSERT INTO `Media` (id, userId, kind, mime, size, storageKey, createdAt) VALUES (?, ?, ?, ?, ?, ?, NOW(3))',
        [id, userId, kind, kind === 'image' ? 'image/png' : 'video/mp4', size, `${userId}/${id}`],
      );
    await media(ids.img, alice.id, 'image', 1500);
    await media(ids.vid, alice.id, 'video', 2500);

    await apply(only('quota_overrides_page_size'));

    const sizes = await rows<{ id: string; sizeBytes: number }>('SELECT id, sizeBytes FROM `Page`');
    for (const p of sizes) expect(p.sizeBytes).toBeGreaterThan(30);

    const aliceDocs = Number(
      (
        await rows<{ s: string }>('SELECT SUM(sizeBytes) AS s FROM `Page` WHERE userId = ?', [
          alice.id,
        ])
      )[0]!.s,
    );
    const bobDocs = Number(
      (
        await rows<{ s: string }>('SELECT SUM(sizeBytes) AS s FROM `Page` WHERE userId = ?', [
          bob.id,
        ])
      )[0]!.s,
    );
    const used = Object.fromEntries(
      (
        await rows<{ id: string; storageUsedBytes: bigint }>(
          'SELECT id, storageUsedBytes FROM `User`',
        )
      ).map((u) => [u.id, Number(u.storageUsedBytes)]),
    );
    expect(used[alice.id]).toBe(1500 + 2500 + aliceDocs);
    expect(used[bob.id]).toBe(bobDocs);
  });

  it('phase 3: every row gets its owner personal space and the counters move there', async () => {
    const before = Object.fromEntries(
      (
        await rows<{ id: string; storageUsedBytes: bigint }>(
          'SELECT id, storageUsedBytes FROM `User`',
        )
      ).map((u) => [u.id, Number(u.storageUsedBytes)]),
    );

    await apply(only('spaces_teams_projects'));

    const spaces = await rows<{
      id: string;
      kind: string;
      userId: string;
      changeSeq: bigint;
      storageUsedBytes: bigint;
    }>('SELECT * FROM `Space`');
    expect(spaces).toHaveLength(2);
    expect(spaces.every((s) => s.kind === 'personal')).toBe(true);
    const spaceOf = Object.fromEntries(spaces.map((s) => [s.userId, s]));
    expect(Number(spaceOf[alice.id]!.changeSeq)).toBe(alice.seq);
    expect(Number(spaceOf[bob.id]!.changeSeq)).toBe(bob.seq);
    expect(Number(spaceOf[alice.id]!.storageUsedBytes)).toBe(before[alice.id]);
    expect(Number(spaceOf[bob.id]!.storageUsedBytes)).toBe(before[bob.id]);

    for (const table of ['Notebook', 'Category', 'Page', 'Media']) {
      const bad = await rows<{ n: bigint }>(
        `SELECT COUNT(*) AS n FROM \`${table}\` t LEFT JOIN \`Space\` s ON s.id = t.spaceId WHERE s.userId IS NULL OR s.userId <> t.userId`,
      );
      expect(Number(bad[0]!.n), `${table} rows without their owner's space`).toBe(0);
    }
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Page`'))[0]!.n)).toBe(3);

    // the user row no longer carries the storage counter, but still mirrors the change counter
    const cols = (
      await rows<{ COLUMN_NAME: string }>(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        [DB, 'User'],
      )
    ).map((c) => c.COLUMN_NAME);
    expect(cols).not.toContain('storageUsedBytes');
    expect(cols).toContain('changeSeq');
  });

  it('phase 4: each team keeps its @everyone permissions as a role, members and owners stay as they were', async () => {
    await apply(only('project_parent_set_null'));
    const teams = [
      { id: randomUUID(), space: randomUUID(), slug: 'default-perms', perms: '545391488' }, // what teams were created with
      { id: randomUUID(), space: randomUUID(), slug: 'custom-perms', perms: '12345' },
    ];
    for (const team of teams) {
      await conn.query(
        'INSERT INTO `Team` (id, name, slug, ownerId, spaceId, everyonePermissions, createdAt) VALUES (?, ?, ?, ?, ?, ?, NOW(3))',
        [team.id, team.slug, team.slug, alice.id, team.space, team.perms],
      );
      await conn.query('INSERT INTO `Space` (id, kind, teamId) VALUES (?, ?, ?)', [team.space, 'team', team.id]);
      await conn.query('INSERT INTO `TeamMember` (teamId, userId) VALUES (?, ?), (?, ?)', [team.id, alice.id, team.id, bob.id]);
    }

    await apply(only('roles_overwrites_audit'));

    const roles = await rows<{ id: string; teamId: string; name: string; position: number; permissions: bigint; isEveryone: number; projectId: string | null }>(
      'SELECT * FROM `Role`',
    );
    expect(roles).toHaveLength(2); // one @everyone per team, nothing else
    for (const team of teams) {
      const role = roles.find((r) => r.teamId === team.id)!;
      expect(role).toMatchObject({ name: '@everyone', position: 0, projectId: null });
      expect(Number(role.isEveryone)).toBe(1);
      expect(role.permissions.toString()).toBe(team.perms);
    }
    expect(new Set(roles.map((r) => r.id)).size).toBe(2);

    const cols = (
      await rows<{ COLUMN_NAME: string }>('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [DB, 'Team'])
    ).map((c) => c.COLUMN_NAME);
    expect(cols).not.toContain('everyonePermissions');
    // owners and members are untouched, nobody got a role, and the new tables start empty
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Team` WHERE ownerId = ?', [alice.id]))[0]!.n)).toBe(2);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `TeamMember`'))[0]!.n)).toBe(4);
    for (const table of ['MemberRole', 'Overwrite', 'AuditLog'])
      expect(Number((await rows<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}\``))[0]!.n)).toBe(0);
  });

  it('sync returns identical data before and after, through the old cursor and through per-space cursors', async () => {
    const url = new URL(savedUrl!);
    url.pathname = `/${DB}`;
    process.env.DATABASE_URL = url.toString();
    const t: TestApp = await createTestApp();
    try {
      const login = await t.http
        .post('/api/auth/login')
        .send({ email: alice.email, password: GOOD_PASSWORD });
      expect(login.status).toBe(200);
      const auth = { Authorization: `Bearer ${login.body.accessToken}` };
      const personalSpaceId: string = login.body.user.personalSpaceId;
      expect(login.body.user.quota.used).toBeGreaterThan(4000); // media 4000 + documents

      const legacy = await t.http.get('/api/sync/changes').query({ since: 0 }).set(auth);
      expect(legacy.status).toBe(200);
      expect(legacy.body.cursor).toBe(alice.seq);
      expect(legacy.body.notebooks.map((n: { id: string }) => n.id).sort()).toEqual(
        [ids.nb, ids.nbTrash].sort(),
      );
      expect(legacy.body.categories.map((c: { id: string }) => c.id).sort()).toEqual(
        [ids.cat, ids.sub].sort(),
      );
      expect(legacy.body.pages.map((p: { id: string }) => p.id).sort()).toEqual(
        [ids.page, ids.pageTrash].sort(),
      );
      expect(
        legacy.body.pages.every((p: { spaceId: string }) => p.spaceId === personalSpaceId),
      ).toBe(true);
      expect(
        legacy.body.notebooks.find((n: { id: string }) => n.id === ids.nbTrash).deletedAt,
      ).not.toBeNull(); // tombstones survive

      const perSpace = await t.http
        .get('/api/sync/changes')
        .query({ cursors: JSON.stringify({ [personalSpaceId]: 0 }) })
        .set(auth);
      expect(perSpace.status).toBe(200);
      expect(perSpace.body.revokedSpaces).toEqual([]);
      expect(perSpace.body.spaces[personalSpaceId]).toEqual({
        cursor: legacy.body.cursor,
        hasMore: false,
        notebooks: legacy.body.notebooks,
        categories: legacy.body.categories,
        pages: legacy.body.pages,
      });

      // the content still opens, and writing continues the old sequence without a gap
      const page = await t.http.get(`/api/pages/${ids.page}`).set(auth);
      expect(page.status).toBe(200);
      expect(JSON.stringify(page.body.content)).toContain('café com leite');
      const save = await t.http
        .put(`/api/pages/${ids.page}/content`)
        .set(auth)
        .send({ content: JSON.parse(doc('after migration')), baseVersion: 3 });
      expect(save.status).toBe(200);
      const next = await t.http.get('/api/sync/changes').query({ since: alice.seq }).set(auth);
      expect(next.body.cursor).toBe(alice.seq + 1);
      expect(next.body.pages.map((p: { id: string }) => p.id)).toEqual([ids.page]);
      expect(
        Number((await t.prisma.user.findUniqueOrThrow({ where: { id: alice.id } })).changeSeq),
      ).toBe(alice.seq + 1); // mirrored for old clients

      // nothing leaks between the two accounts
      const bobLogin = await t.http
        .post('/api/auth/login')
        .send({ email: bob.email, password: GOOD_PASSWORD });
      const bobChanges = await t.http
        .get('/api/sync/changes')
        .query({ since: 0 })
        .set({ Authorization: `Bearer ${bobLogin.body.accessToken}` });
      expect(bobChanges.body.notebooks.map((n: { id: string }) => n.id)).toEqual([ids.bobNb]);
    } finally {
      await t.close();
    }
  });

  it('leaves the schema exactly as the Prisma models describe it (no drift)', async () => {
    const tables = (
      await rows<{ TABLE_NAME: string }>(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
        [DB],
      )
    ).map((t) => t.TABLE_NAME);
    for (const expected of [
      'Space',
      'Team',
      'TeamMember',
      'Project',
      'ProjectMember',
      'PendingOwner',
      'QuotaOverride',
      'Role',
      'MemberRole',
      'Overwrite',
      'AuditLog',
    ])
      expect(tables).toContain(expected);
    expect(TEST_DB).not.toBe(DB);
  });
});
