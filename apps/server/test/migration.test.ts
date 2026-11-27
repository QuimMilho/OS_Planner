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

  it('phase 5: teams, members and owners stay as they were; the directory columns have neutral values and the new tables are empty', async () => {
    await apply(only('joining_teams'));

    const teams = await rows<{ slug: string; isPublic: number; joinPolicy: string; listingBlurb: string; listingTags: unknown; ownerId: string }>(
      'SELECT slug, isPublic, joinPolicy, listingBlurb, listingTags, ownerId FROM `Team` ORDER BY slug',
    );
    expect(teams.map((t) => t.slug)).toEqual(['custom-perms', 'default-perms']);
    for (const t of teams) {
      expect(t.ownerId).toBe(alice.id);
      expect(t.listingBlurb).toBe('');
      expect(t.listingTags).toBeNull();
      expect(Number(t.isPublic)).toBe(0); // nothing is listed until its owner says so
      expect(t.joinPolicy).toBe('request');
    }
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `TeamMember`'))[0]!.n)).toBe(4);
    for (const table of ['Invite', 'PendingInvite', 'JoinRequest', 'Ban'])
      expect(Number((await rows<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}\``))[0]!.n)).toBe(0);

    // one pending request per person and team, but any number of decided ones
    const team = teams[0]!;
    const teamId = (await rows<{ id: string }>('SELECT id FROM `Team` WHERE slug = ?', [team.slug]))[0]!.id;
    const ask = (status: string, pending: number | null) =>
      conn.query(
        'INSERT INTO `JoinRequest` (id, teamId, userId, status, pending) VALUES (?, ?, ?, ?, ?)',
        [randomUUID(), teamId, bob.id, status, pending],
      );
    await ask('pending', 1);
    await expect(ask('pending', 1)).rejects.toThrow(/Duplicate entry/);
    await ask('denied', null);
    await ask('denied', null);
  });

  it('phase 6: everybody is visible by default; phase 7: the chat tables are empty and nothing else changed', async () => {
    await apply(only('realtime_presence'));
    const users = await rows<{ email: string; presenceMode: string }>('SELECT email, presenceMode FROM `User` ORDER BY email');
    expect(users.map((u) => [u.email, u.presenceMode])).toEqual([
      [alice.email, 'auto'],
      [bob.email, 'auto'],
    ]);

    await apply(only('chat_channels'));
    await apply(only('reaction_emoji_binary'));
    for (const table of ['Channel', 'Message', 'Attachment', 'Reaction', 'Thread', 'ChannelRead'])
      expect(Number((await rows<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}\``))[0]!.n), table).toBe(0);
    // what was there is untouched: the notes, the media (now able to carry an attachment) and the teams
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Page`'))[0]!.n)).toBe(3);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Team`'))[0]!.n)).toBe(2);

    // different emoji are different rows (a case-insensitive collation would call them equal), the same one twice is refused
    const user = alice.id;
    const [space] = await rows<{ id: string }>('SELECT id FROM `Space` WHERE userId = ?', [user]);
    const channel = randomUUID();
    const message = randomUUID();
    await conn.query("INSERT INTO `Channel` (id, spaceId, kind, name, position) VALUES (?, ?, 'text', 'general', 'a0')", [channel, space!.id]);
    await conn.query("INSERT INTO `Message` (id, channelId, authorId, content, seq) VALUES (?, ?, ?, 'hi', 1)", [message, channel, user]);
    const react = (emoji: string) => conn.query('INSERT INTO `Reaction` (messageId, userId, emoji) VALUES (?, ?, ?)', [message, user, emoji]);
    await react('👍');
    await react('😂');
    await expect(react('👍')).rejects.toThrow(/Duplicate entry/);
    await conn.query('DELETE FROM `Channel` WHERE id = ?', [channel]); // messages and reactions go with it
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Reaction`'))[0]!.n)).toBe(0);
  });

  it('phase 8: everybody accepts messages from people who share a team, every team allows them, no conversation exists yet, and a conversation channel needs no space', async () => {
    // some chat that already exists keeps its space
    const [space] = await rows<{ id: string }>('SELECT id FROM `Space` WHERE userId = ?', [alice.id]);
    const oldChannel = randomUUID();
    const oldMessage = randomUUID();
    await conn.query("INSERT INTO `Channel` (id, spaceId, kind, name, position) VALUES (?, ?, 'text', 'old', 'a0')", [oldChannel, space!.id]);
    await conn.query("INSERT INTO `Message` (id, channelId, authorId, content, seq) VALUES (?, ?, ?, 'from before', 1)", [oldMessage, oldChannel, alice.id]);

    await apply(only('direct_messages'));
    const users = await rows<{ allowDMsFrom: string }>('SELECT allowDMsFrom FROM `User`');
    expect(users.map((u) => u.allowDMsFrom)).toEqual(['members', 'members']);
    const teams = await rows<{ allowMemberDMs: number }>('SELECT allowMemberDMs FROM `Team`');
    expect(teams.map((t) => Number(t.allowMemberDMs))).toEqual([1, 1]);
    for (const table of ['DirectConversation', 'DirectState', 'UserBlock'])
      expect(Number((await rows<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}\``))[0]!.n), table).toBe(0);
    expect((await rows<{ spaceId: string }>('SELECT spaceId FROM `Channel` WHERE id = ?', [oldChannel]))[0]!.spaceId).toBe(space!.id);

    // a conversation: a channel with no space, one row per pair, and a person who goes leaves the other one the history
    const dmChannel = randomUUID();
    const dm = randomUUID();
    // (two people made for the occasion: the others are needed by the tests that follow)
    const ghost = async (): Promise<string> => {
      const id = randomUUID();
      await conn.query("INSERT INTO `User` (id, email, passwordHash, displayName, updatedAt) VALUES (?, ?, 'x', 'Ghost', NOW(3))", [id, `${id}@example.com`]);
      return id;
    };
    const [a, b] = [await ghost(), await ghost()].sort() as [string, string];
    await conn.query("INSERT INTO `Channel` (id, spaceId, kind, name, position) VALUES (?, NULL, 'dm', '', 'a0')", [dmChannel]);
    const pair = (channel: string) =>
      conn.query('INSERT INTO `DirectConversation` (id, userA, userB, channelId) VALUES (?, ?, ?, ?)', [randomUUID(), a, b, channel]);
    await conn.query('INSERT INTO `DirectConversation` (id, userA, userB, channelId) VALUES (?, ?, ?, ?)', [dm, a, b, dmChannel]);
    const second = randomUUID();
    await conn.query("INSERT INTO `Channel` (id, spaceId, kind, name, position) VALUES (?, NULL, 'dm', '', 'a0')", [second]);
    await expect(pair(second)).rejects.toThrow(/Duplicate entry/);
    await conn.query('DELETE FROM `Channel` WHERE id = ?', [second]);
    await conn.query('DELETE FROM `User` WHERE id = ?', [b]);
    const left = (await rows<{ userA: string | null; userB: string | null }>('SELECT userA, userB FROM `DirectConversation` WHERE id = ?', [dm]))[0]!;
    expect(left).toEqual({ userA: a, userB: null });
    await conn.query('DELETE FROM `Channel` WHERE id = ?', [dmChannel]); // the conversation goes with its channel
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `DirectConversation`'))[0]!.n)).toBe(0);
    await conn.query('DELETE FROM `Channel` WHERE id = ?', [oldChannel]);
  });

  it('phase 9: messages and channels keep their content with neutral new columns, and the notification tables are empty', async () => {
    const [space] = await rows<{ id: string }>('SELECT id FROM `Space` WHERE userId = ?', [alice.id]);
    const channel = randomUUID();
    await conn.query("INSERT INTO `Channel` (id, spaceId, kind, name, position) VALUES (?, ?, 'text', 'before', 'a0')", [channel, space!.id]);
    const user = { id: alice.id };
    await conn.query("INSERT INTO `Message` (id, channelId, authorId, content, seq) VALUES (?, ?, ?, 'old words', 1)", [randomUUID(), channel, user!.id]);

    await apply(only('notifications'));
    const message = (await rows<{ content: string; mentions: unknown }>('SELECT content, mentions FROM `Message` WHERE channelId = ?', [channel]))[0]!;
    expect(message).toEqual({ content: 'old words', mentions: null });
    expect(Number((await rows<{ redactPreviews: number }>('SELECT redactPreviews FROM `Channel` WHERE id = ?', [channel]))[0]!.redactPreviews)).toBe(0);
    expect((await rows<{ quietHours: unknown }>('SELECT quietHours FROM `User` WHERE id = ?', [alice.id]))[0]!.quietHours).toBeNull();
    for (const table of ['NotificationSetting', 'Notification', 'PushSubscription', 'EmailDigestState'])
      expect(Number((await rows<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}\``))[0]!.n), table).toBe(0);

    // one row per person and place; a second push subscription for the same address is refused
    const ghostId = randomUUID();
    await conn.query("INSERT INTO `User` (id, email, passwordHash, displayName, updatedAt) VALUES (?, ?, 'x', 'Ghost', NOW(3))", [ghostId, `${ghostId}@example.com`]);
    const setting = () => conn.query("INSERT INTO `NotificationSetting` (id, userId, scopeKind, scopeId, updatedAt) VALUES (?, ?, 'channel', ?, NOW(3))", [randomUUID(), ghostId, channel]);
    await setting();
    await expect(setting()).rejects.toThrow(/Duplicate entry/);
    const device = () => conn.query("INSERT INTO `PushSubscription` (id, userId, endpoint, endpointHash, p256dh, auth) VALUES (?, ?, 'https://fcm.googleapis.com/x', 'h', 'p', 'a')", [randomUUID(), ghostId]);
    await device();
    await expect(device()).rejects.toThrow(/Duplicate entry/);
    await conn.query('DELETE FROM `User` WHERE id = ?', [ghostId]); // their rows go with them
    await conn.query('DELETE FROM `Channel` WHERE id = ?', [channel]);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `PushSubscription`'))[0]!.n)).toBe(0);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `NotificationSetting`'))[0]!.n)).toBe(0);
  });

  it('phase 10: teams start with public links off, shares and links hang on their notebook, and a move leaves a trace', async () => {
    await apply(only('notebook_sharing'));
    const teams = await rows<{ allowPublicLinks: number }>('SELECT allowPublicLinks FROM `Team`');
    for (const team of teams) expect(Number(team.allowPublicLinks)).toBe(0);

    const [space] = await rows<{ id: string }>('SELECT id FROM `Space` WHERE userId = ?', [alice.id]);
    const nb = randomUUID();
    await conn.query("INSERT INTO `Notebook` (id, spaceId, userId, name, position, seq, updatedAt) VALUES (?, ?, ?, 'Shared', 'a0', 1, NOW(3))", [nb, space!.id, alice.id]);
    const linkId = randomUUID();
    await conn.query("INSERT INTO `ShareLink` (id, notebookId, tokenHash, access, createdBy) VALUES (?, ?, ?, 'edit', ?)", [linkId, nb, 'a'.repeat(64), alice.id]);
    await expect(conn.query("INSERT INTO `ShareLink` (id, notebookId, tokenHash, access, createdBy) VALUES (?, ?, ?, 'read', ?)", [randomUUID(), nb, 'a'.repeat(64), alice.id])).rejects.toThrow(/Duplicate entry/);
    const share = () => conn.query("INSERT INTO `NotebookShare` (id, notebookId, userId, access, linkId, createdBy) VALUES (?, ?, ?, 'edit', ?, ?)", [randomUUID(), nb, bob.id, linkId, alice.id]);
    await share();
    await expect(share()).rejects.toThrow(/Duplicate entry/); // one share per person and notebook
    await conn.query("INSERT INTO `PendingShare` (id, notebookId, email, access, createdBy) VALUES (?, ?, 'x@example.com', 'read', ?)", [randomUUID(), nb, alice.id]);

    // deleting the link takes the shares that came from it; deleting the notebook takes the rest
    await conn.query('DELETE FROM `ShareLink` WHERE id = ?', [linkId]);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `NotebookShare` WHERE notebookId = ?', [nb]))[0]!.n)).toBe(0);
    await conn.query('DELETE FROM `Notebook` WHERE id = ?', [nb]);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `PendingShare` WHERE notebookId = ?', [nb]))[0]!.n)).toBe(0);
  });

  it('phase 11: existing pages keep their content and have no Yjs state yet; the state and its snapshots go with the page', async () => {
    const before = await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Page`');
    await apply(only('page_yjs'));
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `PageYDoc`'))[0]!.n)).toBe(0);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Page`'))[0]!.n)).toBe(Number(before[0]!.n));

    const [space] = await rows<{ id: string }>('SELECT id FROM `Space` WHERE userId = ?', [alice.id]);
    const nb = randomUUID();
    const cat = randomUUID();
    const page = randomUUID();
    await conn.query("INSERT INTO `Notebook` (id, spaceId, userId, name, position, seq, updatedAt) VALUES (?, ?, ?, 'Y', 'a0', 1, NOW(3))", [nb, space!.id, alice.id]);
    await conn.query("INSERT INTO `Category` (id, spaceId, userId, notebookId, name, position, seq, updatedAt) VALUES (?, ?, ?, ?, 'c', 'a0', 1, NOW(3))", [cat, space!.id, alice.id, nb]);
    await conn.query("INSERT INTO `Page` (id, spaceId, userId, notebookId, categoryId, title, content, contentText, position, seq, updatedAt) VALUES (?, ?, ?, ?, ?, 'p', ?, '', 'a0', 1, NOW(3))", [page, space!.id, alice.id, nb, cat, doc('x')]);
    await conn.query('INSERT INTO `PageYDoc` (pageId, state, stateVector) VALUES (?, ?, ?)', [page, Buffer.from([1, 2, 3]), Buffer.from([0])]);
    await conn.query("INSERT INTO `PageYSnapshot` (id, pageId, state, reason) VALUES (?, ?, ?, 'hourly')", [randomUUID(), page, Buffer.from([1])]);
    await conn.query('DELETE FROM `Notebook` WHERE id = ?', [nb]);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `PageYDoc` WHERE pageId = ?', [page]))[0]!.n)).toBe(0);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `PageYSnapshot` WHERE pageId = ?', [page]))[0]!.n)).toBe(0);
  });

  it('phase 12: the board tables start empty, existing spaces and media are untouched, and what hangs off a task goes with it', async () => {
    const spaces = Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Space`'))[0]!.n);
    const media = Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Media`'))[0]!.n);
    await apply(only('boards_tasks'));
    for (const table of ['Board', 'BoardColumn', 'Task', 'TaskAssignee', 'Label', 'TaskLabel', 'ChecklistItem', 'TaskComment', 'TaskAttachment', 'TaskActivity', 'TaskMove'])
      expect(Number((await rows<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}\``))[0]!.n), table).toBe(0);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Space`'))[0]!.n)).toBe(spaces);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Media`'))[0]!.n)).toBe(media);

    const [space] = await rows<{ id: string }>('SELECT id FROM `Space` WHERE userId = ?', [alice.id]);
    const board = randomUUID();
    const col = randomUUID();
    const task = randomUUID();
    await conn.query("INSERT INTO `Board` (id, spaceId, name, position, seq, updatedAt) VALUES (?, ?, 'B', 'a0', 1, NOW(3))", [board, space!.id]);
    await conn.query("INSERT INTO `BoardColumn` (id, boardId, spaceId, name, position, seq) VALUES (?, ?, ?, 'To do', 'a0', 1)", [col, board, space!.id]);
    await conn.query("INSERT INTO `Task` (id, boardId, columnId, spaceId, title, position, seq, updatedAt) VALUES (?, ?, ?, ?, 'T', 'a0', 1, NOW(3))", [task, board, col, space!.id]);
    await conn.query('INSERT INTO `TaskAssignee` (taskId, userId) VALUES (?, ?)', [task, alice.id]);
    await conn.query("INSERT INTO `ChecklistItem` (id, taskId, text, position) VALUES (?, ?, 'x', 'a0')", [randomUUID(), task]);
    await conn.query("INSERT INTO `TaskComment` (id, taskId, content) VALUES (?, ?, 'hi')", [randomUUID(), task]);
    await conn.query("INSERT INTO `TaskActivity` (id, taskId, kind) VALUES (?, ?, 'created')", [randomUUID(), task]);
    // deleting the board takes its columns and tasks, and what hangs off them
    await conn.query('DELETE FROM `Board` WHERE id = ?', [board]);
    for (const table of ['BoardColumn', 'Task', 'TaskAssignee', 'ChecklistItem', 'TaskComment', 'TaskActivity'])
      expect(Number((await rows<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}\``))[0]!.n), table).toBe(0);
  });

  it('phase 13: the calendar tables start empty, existing data is untouched, and what hangs off an event goes with it', async () => {
    const spaces = Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Space`'))[0]!.n);
    const users = Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `User`'))[0]!.n);
    await apply(only('calendar'));
    for (const table of ['Event', 'EventException', 'EventAttendee', 'EventReminder', 'ReminderDelivery', 'UserCalendarSetting'])
      expect(Number((await rows<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}\``))[0]!.n), table).toBe(0);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Space`'))[0]!.n)).toBe(spaces);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `User`'))[0]!.n)).toBe(users);

    const [space] = await rows<{ id: string }>('SELECT id FROM `Space` WHERE userId = ?', [alice.id]);
    const event = randomUUID();
    await conn.query("INSERT INTO `Event` (id, spaceId, ownerId, title, description, startAt, endAt, seq, updatedAt) VALUES (?, ?, ?, 'E', '', NOW(3), NOW(3), 1, NOW(3))", [event, space!.id, alice.id]);
    await conn.query("INSERT INTO `EventAttendee` (eventId, kind, subjectId) VALUES (?, 'user', ?)", [event, alice.id]);
    await conn.query("INSERT INTO `EventException` (id, eventId, originalStart, kind) VALUES (?, ?, NOW(3), 'cancelled')", [randomUUID(), event]);
    await conn.query("INSERT INTO `EventReminder` (eventId, userId, minutes) VALUES (?, ?, '[10]')", [event, alice.id]);
    await conn.query('INSERT INTO `ReminderDelivery` (eventId, userId, occurrenceStart, minutesBefore) VALUES (?, ?, NOW(3), 10)', [event, alice.id]);
    await conn.query("INSERT INTO `UserCalendarSetting` (userId, defaultReminders, hiddenSpaces) VALUES (?, '[10]', '[]')", [alice.id]);
    // an event takes its people, exceptions, reminders and records with it
    await conn.query('DELETE FROM `Event` WHERE id = ?', [event]);
    for (const table of ['EventAttendee', 'EventException', 'EventReminder', 'ReminderDelivery'])
      expect(Number((await rows<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}\``))[0]!.n), table).toBe(0);
    // a person's settings go with the person only
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `UserCalendarSetting` WHERE userId = ?', [alice.id]))[0]!.n)).toBe(1);
  });

  it('phase 14: the feed and followed-calendar tables start empty, events keep their data, and what hangs off a person goes with them', async () => {
    const events = Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Event`'))[0]!.n);
    const [space] = await rows<{ id: string }>('SELECT id FROM `Space` WHERE userId = ?', [alice.id]);
    const old = randomUUID();
    await conn.query("INSERT INTO `Event` (id, spaceId, ownerId, title, description, startAt, endAt, seq, updatedAt) VALUES (?, ?, ?, 'Old', '', NOW(3), NOW(3), 1, NOW(3))", [old, space!.id, alice.id]);
    await apply(only('ics_feeds'));
    await apply(only('ics_attempt'));
    for (const table of ['CalendarFeed', 'ExternalCalendar', 'ExternalEvent'])
      expect(Number((await rows<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}\``))[0]!.n), table).toBe(0);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Event`'))[0]!.n)).toBe(events + 1);
    expect((await rows<{ icsUid: string | null }>('SELECT icsUid FROM `Event` WHERE id = ?', [old]))[0]!.icsUid).toBeNull();

    const cal = randomUUID();
    await conn.query("INSERT INTO `CalendarFeed` (id, userId, tokenHash, tokenHint, name, `include`) VALUES (?, ?, ?, 'abc123', 'Phone', '{}')", [randomUUID(), bob.id, 'a'.repeat(64)]);
    await conn.query("INSERT INTO `ExternalCalendar` (id, userId, name, url, color, nextSyncAt) VALUES (?, ?, 'Work', 'https://x.test/a.ics', '#112233', NOW(3))", [cal, bob.id]);
    await conn.query("INSERT INTO `ExternalEvent` (id, calendarId, uid, startAt, endAt, title, description) VALUES (?, ?, 'u1', NOW(3), NOW(3), 'T', '')", [randomUUID(), cal]);
    // the same event twice in one calendar is refused
    await expect(
      conn.query("INSERT INTO `ExternalEvent` (id, calendarId, uid, startAt, endAt, title, description) VALUES (?, ?, 'u1', NOW(3), NOW(3), 'T', '')", [randomUUID(), cal]),
    ).rejects.toThrow();
    // a calendar takes its events with it
    await conn.query('DELETE FROM `ExternalCalendar` WHERE id = ?', [cal]);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `ExternalEvent`'))[0]!.n)).toBe(0);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `CalendarFeed` WHERE userId = ?', [bob.id]))[0]!.n)).toBe(1);
    await conn.query('DELETE FROM `Event` WHERE id = ?', [old]);
  });

  it('phase 15: rows that exist keep everything and have no field versions (nothing changed since they were made); new rows can carry them', async () => {
    const count = async (table: string) => Number((await rows<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}\``))[0]!.n);
    const [space] = await rows<{ id: string }>('SELECT id FROM `Space` WHERE userId = ?', [alice.id]);
    const event = randomUUID();
    await conn.query("INSERT INTO `Event` (id, spaceId, ownerId, title, description, startAt, endAt, seq, updatedAt) VALUES (?, ?, ?, 'Before', '', NOW(3), NOW(3), 7, NOW(3))", [event, space!.id, alice.id]);
    const before = { notebooks: await count('Notebook'), categories: await count('Category'), pages: await count('Page'), events: await count('Event') };
    await apply(only('field_seq'));
    expect({ notebooks: await count('Notebook'), categories: await count('Category'), pages: await count('Page'), events: await count('Event') }).toEqual(before);
    for (const table of ['Notebook', 'Category', 'Page', 'Task', 'Event'])
      expect(Number((await rows<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE fieldSeq IS NOT NULL`))[0]!.n), table).toBe(0);
    expect((await rows<{ title: string; seq: bigint }>('SELECT title, seq FROM `Event` WHERE id = ?', [event]))[0]).toMatchObject({ title: 'Before', seq: 7n });
    await conn.query('UPDATE `Event` SET fieldSeq = ? WHERE id = ?', [JSON.stringify({ title: 9 }), event]);
    const stored = (await rows<{ fieldSeq: unknown }>('SELECT fieldSeq FROM `Event` WHERE id = ?', [event]))[0]!.fieldSeq;
    expect(typeof stored === 'string' ? JSON.parse(stored) : stored).toEqual({ title: 9 });
    await conn.query('DELETE FROM `Event` WHERE id = ?', [event]);
  });

  it('phase 16: channels keep their data (no limit, no quality), the presence table starts empty and goes with its channel or person', async () => {
    const count = async (table: string) => Number((await rows<{ n: bigint }>(`SELECT COUNT(*) AS n FROM \`${table}\``))[0]!.n);
    const [space] = await rows<{ id: string }>('SELECT id FROM `Space` WHERE userId = ?', [alice.id]);
    const old = randomUUID();
    await conn.query("INSERT INTO `Channel` (id, spaceId, kind, name, position) VALUES (?, ?, 'text', 'general', 'a0')", [old, space!.id]);
    const channels = await count('Channel');
    await apply(only('voice'));
    expect(await count('Channel')).toBe(channels);
    expect(await count('VoiceParticipant')).toBe(0);
    expect((await rows<{ userLimit: number | null; quality: string | null }>('SELECT userLimit, quality FROM `Channel` WHERE id = ?', [old]))[0]).toEqual({ userLimit: null, quality: null });

    const voice = randomUUID();
    await conn.query("INSERT INTO `Channel` (id, spaceId, kind, name, position, userLimit, quality) VALUES (?, ?, 'voice', 'Lounge', 'a1', 4, 'high')", [voice, space!.id]);
    await conn.query("INSERT INTO `VoiceParticipant` (channelId, userId, sid) VALUES (?, ?, 'PA_1')", [voice, alice.id]);
    // one connection of a person per channel
    await expect(conn.query("INSERT INTO `VoiceParticipant` (channelId, userId, sid) VALUES (?, ?, 'PA_2')", [voice, alice.id])).rejects.toThrow();
    expect((await rows<{ grants: number; mutedByModerator: number }>('SELECT grants, mutedByModerator FROM `VoiceParticipant`'))[0]).toMatchObject({ grants: 0, mutedByModerator: 0 });
    await conn.query('DELETE FROM `Channel` WHERE id = ?', [voice]);
    expect(await count('VoiceParticipant')).toBe(0);
    await conn.query('DELETE FROM `Channel` WHERE id = ?', [old]);
  });

  it('phase 17: the copy of the change sequence on the user goes, the personal space keeps the counter', async () => {
    const [before] = await rows<{ changeSeq: bigint }>('SELECT changeSeq FROM `Space` WHERE userId = ?', [alice.id]);
    const users = Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `User`'))[0]!.n);
    await apply(only('drop_user_change_seq'));
    const cols = (await rows<{ COLUMN_NAME: string }>('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [DB, 'User'])).map((c) => c.COLUMN_NAME);
    expect(cols).not.toContain('changeSeq');
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `User`'))[0]!.n)).toBe(users);
    const [after] = await rows<{ changeSeq: bigint }>('SELECT changeSeq FROM `Space` WHERE userId = ?', [alice.id]);
    expect(Number(after!.changeSeq)).toBe(Number(before!.changeSeq));
  });

  it('phase 17: the inbox gets an index that orders it newest first; notifications stay as they were', async () => {
    const before = Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Notification`'))[0]!.n);
    await apply(only('inbox_index'));
    const idx = await rows<{ INDEX_NAME: string; COLUMN_NAME: string; SEQ_IN_INDEX: number }>(
      "SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'Notification' AND INDEX_NAME = 'Notification_userId_createdAt_idx' ORDER BY SEQ_IN_INDEX",
      [DB],
    );
    expect(idx.map((c) => c.COLUMN_NAME)).toEqual(['userId', 'createdAt']);
    expect(Number((await rows<{ n: bigint }>('SELECT COUNT(*) AS n FROM `Notification`'))[0]!.n)).toBe(before);
  });

  it('upgrading from the single-user release: sync returns the same data through per-space cursors, and writing goes on', async () => {
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

      const first = await t.http
        .get('/api/sync/changes')
        .query({ cursors: JSON.stringify({ [personalSpaceId]: 0 }) })
        .set(auth);
      expect(first.status).toBe(200);
      const legacy = { body: first.body.spaces[personalSpaceId] };
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
        // phase 12: the board tables are part of every space's answer (empty here)
        boards: [],
        columns: [],
        tasks: [],
        labels: [],
        // phase 13: and so are the events the person may see (none here)
        events: [],
      });

      // the content still opens, and writing continues the old sequence without a gap
      const page = await t.http.get(`/api/pages/${ids.page}`).set(auth);
      expect(page.status).toBe(200);
      expect(JSON.stringify(page.body.content)).toContain('café com leite');
      const save = await t.http
        .post(`/api/pages/${ids.page}/snapshots/replace`)
        .set(auth)
        .send({ content: JSON.parse(doc('after migration')), baseVersion: 3 });
      expect(save.status).toBe(200);
      const next = (
        await t.http
          .get('/api/sync/changes')
          .query({ cursors: JSON.stringify({ [personalSpaceId]: alice.seq }) })
          .set(auth)
      ).body.spaces[personalSpaceId];
      expect(next.cursor).toBe(alice.seq + 1);
      expect(next.pages.map((p: { id: string }) => p.id)).toEqual([ids.page]);
      expect(
        Number((await t.prisma.space.findUniqueOrThrow({ where: { id: personalSpaceId } })).changeSeq),
      ).toBe(alice.seq + 1);

      // nothing leaks between the two accounts
      const bobLogin = await t.http
        .post('/api/auth/login')
        .send({ email: bob.email, password: GOOD_PASSWORD });
      const bobSpace: string = bobLogin.body.user.personalSpaceId;
      const bobChanges = await t.http
        .get('/api/sync/changes')
        .query({ cursors: JSON.stringify({ [bobSpace]: 0, [personalSpaceId]: 0 }) })
        .set({ Authorization: `Bearer ${bobLogin.body.accessToken}` });
      expect(bobChanges.body.spaces[bobSpace].notebooks.map((n: { id: string }) => n.id)).toEqual([ids.bobNb]);
      expect(bobChanges.body.revokedSpaces).toEqual([personalSpaceId]);
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
      'Invite',
      'PendingInvite',
      'JoinRequest',
      'Ban',
      'Channel',
      'Message',
      'Attachment',
      'Reaction',
      'Thread',
      'ChannelRead',
      'DirectConversation',
      'DirectState',
      'UserBlock',
      'NotificationSetting',
      'Notification',
      'PushSubscription',
      'EmailDigestState',
    ])
      expect(tables).toContain(expected);
    expect(TEST_DB).not.toBe(DB);
  });
});
