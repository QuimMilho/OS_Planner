import { randomUUID } from 'node:crypto';
import { positionBetween } from '@os-planner/shared';
import { QuotaService } from '../src/quota/quota.service.js';
import type { TestApp } from './app.js';
import { GOOD_PASSWORD, uniqueEmail } from './app.js';

export const uuid = (): string => randomUUID();

export interface Account {
  id: string;
  email: string;
  token: string;
  auth: { Authorization: string };
}

export async function signup(t: TestApp, verified = true, email = uniqueEmail()): Promise<Account> {
  const res = await t.http.post('/api/auth/register').send({ email, password: GOOD_PASSWORD, displayName: 'Test' });
  if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
  if (verified) await t.prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
  return {
    id: res.body.user.id,
    email,
    token: res.body.accessToken,
    auth: { Authorization: `Bearer ${res.body.accessToken}` },
  };
}

/** The id of a person's own space (their notebooks, sync cursor and storage live there). */
export async function personalSpaceId(t: TestApp, userId: string): Promise<string> {
  return (await t.prisma.space.findUniqueOrThrow({ where: { userId }, select: { id: true } })).id;
}

/** Bytes counted against a person's storage (media + documents), whichever table holds the counter. */
export async function usedBytes(t: TestApp, userId: string): Promise<number> {
  return t.app.get(QuotaService).usage('user', userId);
}

/** Thin wrappers that create tree items through the REST API and return the DTO. */
export function builders(t: TestApp, who: Account) {
  let last: string | null = null;
  const nextPosition = (): string => (last = positionBetween(last, null)); // a0, a1, ... a9, aA, ...

  const notebook = async (name = 'Notebook') => {
    const id = uuid();
    const res = await t.http.post('/api/notebooks').set(who.auth).send({ id, name, position: nextPosition() });
    if (res.status >= 300) throw new Error(`notebook failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; name: string; position: string; seq: number; deletedAt: string | null };
  };

  const category = async (notebookId: string, name = 'Category', parentId: string | null = null) => {
    const res = await t.http
      .post('/api/categories')
      .set(who.auth)
      .send({ id: uuid(), notebookId, parentId, name, position: nextPosition() });
    if (res.status >= 300) throw new Error(`category failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; notebookId: string; parentId: string | null; name: string; deletedAt: string | null };
  };

  const page = async (categoryId: string, title = 'Page') => {
    const res = await t.http
      .post('/api/pages')
      .set(who.auth)
      .send({ id: uuid(), categoryId, title, position: nextPosition() });
    if (res.status >= 300) throw new Error(`page failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as { id: string; notebookId: string; categoryId: string; title: string; version: number; deletedAt: string | null };
  };

  return { notebook, category, page, nextPosition };
}

export const para = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** A UUIDv7 like the web app makes for messages: a millisecond timestamp first, so ids sort by time. Later calls always sort later. */
let lastMs = 0;
let sequence = 0;
export function uuidv7(): string {
  const now = Date.now();
  if (now === lastMs) sequence++;
  else (lastMs = now, (sequence = 0));
  const ms = BigInt(now);
  const hex = (n: bigint, len: number) => n.toString(16).padStart(len, '0');
  const rand = hex(BigInt(Math.floor(Math.random() * 2 ** 48)), 12);
  // 48 bits of time, version 7, then a counter that keeps ids made in the same millisecond in order, then random bits
  const time = hex(ms, 12);
  const counter = hex(BigInt(sequence & 0xfff), 3);
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${counter}-${(0x8 | (Math.floor(Math.random() * 4))).toString(16)}${rand.slice(0, 3)}-${rand.slice(3, 12)}${hex(BigInt(Math.floor(Math.random() * 2 ** 12)), 3)}`;
}
