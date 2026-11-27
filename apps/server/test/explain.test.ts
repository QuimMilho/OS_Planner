/**
 * Phase 17 (section C): the hot queries use their indexes. Each query below has the shape the services send (chat history and catch-up,
 * unread counts, sync of a space, the calendar window, the inbox and its count); MySQL's plan for it must name an index, never scan the
 * whole table, and the ordered ones must not sort in memory. Run on a data set big enough for the optimizer to care.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.js';
import { createTestApp, type TestApp } from './app.js';
import { personalSpaceId, signup, uuidv7, type Account } from './helpers.js';

let t: TestApp;
let me: Account;
let other: Account;
let space: string;
let channel: string;
let quiet: string;

interface Plan {
  table: string;
  type: string;
  key: string | null;
  rows: number | bigint;
  Extra: string | null;
}
const explain = async (sql: Prisma.Sql): Promise<Plan[]> =>
  t.prisma.$queryRaw<Plan[]>(Prisma.sql`EXPLAIN ${sql}`);
const plan = (rows: Plan[], table: string) => rows.find((r) => r.table === table)!;

beforeAll(async () => {
  t = await createTestApp();
  await t.prisma.team.deleteMany();
  await t.prisma.user.deleteMany();
  me = await signup(t);
  other = await signup(t);
  space = await personalSpaceId(t, me.id);
  // An instance with many people, spaces and channels: the rows of the one asked about are a small part of each table, as they are in
  // real life (with everything in one place, a full scan is the right plan and the check would mean nothing).
  const others: { id: string; space: string }[] = [];
  for (let i = 0; i < 24; i++) {
    const a = await signup(t);
    others.push({ id: a.id, space: await personalSpaceId(t, a.id) });
  }
  const everyone = [{ id: me.id, space }, ...others];
  const channels: string[] = [];
  for (const [i, who] of everyone.entries())
    for (let c = 0; c < 2; c++) {
      const id = randomUUID();
      channels.push(id);
      await t.prisma.channel.create({
        data: { id, spaceId: who.space, kind: 'text', name: `c${i}-${c}`, position: `a${c}` },
      });
    }
  channel = channels[0]!;
  quiet = channels[1]!;
  let seq = 0n;
  const messages = Array.from({ length: 80 }, (_, i) => i).flatMap((i) =>
    channels.map((channelId) => ({
      id: uuidv7(),
      channelId,
      authorId: i % 2 ? me.id : other.id,
      content: `message ${i}`,
      seq: ++seq,
    })),
  );
  for (let i = 0; i < messages.length; i += 500)
    await t.prisma.message.createMany({ data: messages.slice(i, i + 500) });
  const pages = [];
  for (const who of everyone) {
    const notebook = randomUUID();
    await t.prisma.notebook.create({
      data: {
        id: notebook,
        userId: who.id,
        spaceId: who.space,
        name: 'N',
        position: 'a0',
        seq: 1n,
      },
    });
    const category = randomUUID();
    await t.prisma.category.create({
      data: {
        id: category,
        userId: who.id,
        spaceId: who.space,
        notebookId: notebook,
        name: 'C',
        position: 'a0',
        seq: 1n,
      },
    });
    for (let i = 0; i < 60; i++)
      pages.push({
        id: randomUUID(),
        userId: who.id,
        spaceId: who.space,
        notebookId: notebook,
        categoryId: category,
        title: `p${i}`,
        position: 'a0',
        content: {},
        contentText: '',
        seq: BigInt(i + 2),
      });
  }
  for (let i = 0; i < pages.length; i += 500)
    await t.prisma.page.createMany({ data: pages.slice(i, i + 500) });
  const notifications = everyone.flatMap((who, u) =>
    Array.from({ length: 80 }, (_, i) => ({
      id: randomUUID(),
      userId: who.id,
      kind: 'mention_user',
      targetKind: 'channel',
      targetId: channels[u * 2]!,
      channelId: channels[u * 2]!,
      summary: 'mentioned you',
      createdAt: new Date(Date.now() - i * 60_000),
      readAt: i % 3 ? new Date() : null,
    })),
  );
  for (let i = 0; i < notifications.length; i += 500)
    await t.prisma.notification.createMany({ data: notifications.slice(i, i + 500) as never });
  const events = everyone.flatMap((who) =>
    Array.from({ length: 40 }, (_, i) => ({
      id: randomUUID(),
      spaceId: who.space,
      ownerId: who.id,
      title: `e${i}`,
      description: '',
      kind: 'meeting',
      startAt: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000 * 200),
      endAt: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000 * 200 + 1_800_000),
      timezone: 'UTC',
      visibility: 'space',
      seq: BigInt(i + 1),
    })),
  );
  for (let i = 0; i < events.length; i += 400)
    await t.prisma.event.createMany({ data: events.slice(i, i + 400) as never });
  for (const table of ['Message', 'Page', 'Notification', 'Event', 'ChannelRead'])
    await t.prisma.$executeRawUnsafe(`ANALYZE TABLE \`${table}\``);
}, 120_000);
afterAll(async () => {
  await t.prisma.user.deleteMany();
  await t.close();
});

describe('the hot queries use their indexes', () => {
  it('a page of chat history and the catch-up after a lost connection', async () => {
    const last = (
      await t.prisma.message.findFirstOrThrow({
        where: { channelId: channel },
        orderBy: { id: 'desc' },
      })
    ).id;
    const page = plan(
      await explain(
        Prisma.sql`SELECT * FROM Message WHERE channelId = ${channel} AND threadId IS NULL AND id < ${last} ORDER BY id DESC LIMIT 50`,
      ),
      'Message',
    );
    // the channel's own rows only, through one of its (channelId, …) indexes
    expect(page.key).toMatch(/^Message_channelId_/);
    expect(Number(page.rows)).toBeLessThanOrEqual(200);
    const catchUp = plan(
      await explain(
        Prisma.sql`SELECT * FROM Message WHERE channelId = ${channel} AND seq > ${100} ORDER BY seq LIMIT 200`,
      ),
      'Message',
    );
    expect(catchUp.key).toBe('Message_channelId_seq_idx');
    expect(catchUp.Extra ?? '').not.toMatch(/filesort/);
  });

  it('unread counts of the channels of a team', async () => {
    const rows = await explain(Prisma.sql`
      SELECT m.channelId AS channelId, COUNT(*) AS n
      FROM Message m
      LEFT JOIN ChannelRead r ON r.channelId = m.channelId AND r.userId = ${me.id}
      WHERE m.channelId IN (${Prisma.join([channel, quiet])})
        AND m.threadId IS NULL AND m.deletedAt IS NULL
        AND (m.authorId IS NULL OR m.authorId <> ${me.id})
        AND (r.lastReadMessageId IS NULL OR m.id > r.lastReadMessageId)
        AND (r.userId IS NOT NULL OR m.createdAt >= ${new Date(0)})
      GROUP BY m.channelId`);
    const m = plan(rows, 'm');
    expect(m.type).not.toBe('ALL');
    expect(m.key).toMatch(/^Message_channelId_/);
    expect(plan(rows, 'r').type).toMatch(/eq_ref|ref|const/);
  });

  it('sync of one space after a cursor', async () => {
    for (const table of ['Page', 'Notebook', 'Category', 'Task', 'Event', 'Board', 'Label']) {
      const p = plan(
        await explain(
          Prisma.sql`SELECT * FROM ${Prisma.raw(`\`${table}\``)} WHERE spaceId = ${space} AND seq > ${10} AND seq <= ${5000} ORDER BY seq LIMIT 1000`,
        ),
        table,
      );
      expect(p.key, table).toBe(`${table}_spaceId_seq_idx`);
      expect(p.Extra ?? '', table).not.toMatch(/filesort/);
    }
  });

  it('the calendar window of a few spaces', async () => {
    const p = plan(
      await explain(
        Prisma.sql`SELECT * FROM Event WHERE spaceId IN (${Prisma.join([space, randomUUID()])}) AND deletedAt IS NULL AND startAt < ${new Date(Date.UTC(2026, 2, 1))} AND (endAt > ${new Date(Date.UTC(2026, 1, 1))} OR rrule IS NOT NULL)`,
      ),
      'Event',
    );
    expect(p.type).not.toBe('ALL');
    expect(p.key).toMatch(/^Event_spaceId_/);
  });

  it('the inbox, newest first, and its unread count', async () => {
    // one person's notifications only (either index on userId bounds it; with many per person the optimizer takes (userId, createdAt), which orders them)
    const list = plan(
      await explain(
        Prisma.sql`SELECT * FROM Notification WHERE userId = ${me.id} ORDER BY createdAt DESC, id DESC LIMIT 31`,
      ),
      'Notification',
    );
    expect(list.key).toMatch(/^Notification_userId_/);
    expect(Number(list.rows)).toBeLessThanOrEqual(200);
    const unread = plan(
      await explain(
        Prisma.sql`SELECT * FROM Notification WHERE userId = ${me.id} AND readAt IS NULL ORDER BY createdAt DESC, id DESC LIMIT 31`,
      ),
      'Notification',
    );
    expect(unread.key).toMatch(/^Notification_userId_/);
    const count = plan(
      await explain(
        Prisma.sql`SELECT kind, targetKind, targetId, COUNT(*) FROM Notification WHERE userId = ${me.id} AND readAt IS NULL GROUP BY kind, targetKind, targetId`,
      ),
      'Notification',
    );
    expect(count.key).toBe('Notification_userId_readAt_createdAt_idx');
  });
});
