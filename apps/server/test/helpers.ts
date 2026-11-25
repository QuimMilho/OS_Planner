import { randomUUID } from 'node:crypto';
import { positionBetween } from '@notes/shared';
import type { TestApp } from './app.js';
import { GOOD_PASSWORD, uniqueEmail } from './app.js';

export const uuid = (): string => randomUUID();

export interface Account {
  id: string;
  email: string;
  token: string;
  auth: { Authorization: string };
}

export async function signup(t: TestApp, verified = true): Promise<Account> {
  const email = uniqueEmail();
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
