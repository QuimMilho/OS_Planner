import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSnippet, fold, parseSearchQuery } from '../src/search/query.js';
import { createTestApp, type TestApp } from './app.js';
import { builders, signup, type Account } from './helpers.js';

describe('query parsing (unit)', () => {
  it('folds accents and case without changing length', () => {
    expect(fold('Acentuação É Física')).toBe('acentuacao e fisica');
    expect(fold('Ünïcödé').length).toBe('Ünïcödé'.length);
  });

  it('makes every word a required prefix match', () => {
    expect(parseSearchQuery('quantum mecânica').boolean).toBe('+quantum* +mecanica*');
  });

  it('keeps quoted phrases', () => {
    expect(parseSearchQuery('"wave function" collapse').boolean).toBe('+"wave function" +collapse*');
  });

  it('strips every boolean-mode operator so input cannot change the query structure', () => {
    for (const hostile of ['+-<>()~*"@', 'a* -b +c ~d (e) <f> @g', '"unterminated', '--', '"" ""']) {
      const { boolean } = parseSearchQuery(hostile);
      if (boolean) expect(boolean).toMatch(/^(\+("[\p{L}\p{N} ]+"|[\p{L}\p{N}]+\*)(?: |$))+$/u);
    }
    expect(parseSearchQuery('+-<>()~*"@').boolean).toBeNull();
  });

  it('ignores one-letter words (the index would, too) and caps the term count', () => {
    expect(parseSearchQuery('a b c').boolean).toBeNull();
    expect(parseSearchQuery('x yz').boolean).toBe('+yz*');
    const many = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    expect(parseSearchQuery(many).words).toHaveLength(12);
  });

  it('builds a snippet that highlights accent-insensitive matches in the original text', () => {
    const text = 'A física quântica descreve o comportamento da matéria. Fisicamente falando, tudo é energia.';
    const snip = buildSnippet(text, parseSearchQuery('fisica'));
    expect(snip).toContain('[[física]]');
    expect(snip).toContain('[[Fisicamente]]');
  });

  it('adds ellipses when it cuts the text', () => {
    const text = 'x '.repeat(300) + 'needle ' + 'y '.repeat(300);
    const snip = buildSnippet(text, parseSearchQuery('needle'));
    expect(snip.startsWith('…')).toBe(true);
    expect(snip.endsWith('…')).toBe(true);
    expect(snip).toContain('[[needle]]');
    expect(snip.length).toBeLessThan(300);
  });
});

describe('GET /api/search (full-text, MySQL)', () => {
  let t: TestApp;
  let me: Account;
  let b: ReturnType<typeof builders>;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.prisma.user.deleteMany();
    me = await signup(t);
    b = builders(t, me);
  });

  const write = async (pageId: string, text: string) => {
    const res = await t.http.post(`/api/pages/${pageId}/snapshots/replace`).set(me.auth).send({
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
      baseVersion: 0,
    });
    expect(res.status).toBe(200);
  };
  const search = (q: string, who = me, extra = '') =>
    t.http.get(`/api/search?q=${encodeURIComponent(q)}${extra}`).set(who.auth);

  it('finds accented text with unaccented queries, and the reverse', async () => {
    const cat = await b.category((await b.notebook('Ciência')).id, 'Física');
    const page = await b.page(cat.id, 'Aula de Física');
    await write(page.id, 'A acentuação das palavras é importante.');

    for (const q of ['acentuacao', 'ACENTUAÇÃO', 'fisica', 'Física']) {
      const res = await search(q);
      expect(res.status).toBe(200);
      expect(res.body.map((r: { pageId: string }) => r.pageId), `query "${q}"`).toContain(page.id);
    }
  });

  it('matches prefixes, so results appear while typing', async () => {
    const cat = await b.category((await b.notebook()).id);
    const page = await b.page(cat.id, 'Thermodynamics');
    await write(page.id, 'Entropy never decreases');
    expect((await search('thermo')).body).toHaveLength(1);
    expect((await search('entro')).body).toHaveLength(1);
  });

  it('requires all words (AND) and supports phrases', async () => {
    const cat = await b.category((await b.notebook()).id);
    const p1 = await b.page(cat.id, 'one');
    const p2 = await b.page(cat.id, 'two');
    await write(p1.id, 'the red apple fell from the tree');
    await write(p2.id, 'a red car and an apple pie');

    expect((await search('red apple')).body).toHaveLength(2);
    const phrase = await search('"red apple"');
    expect(phrase.body.map((r: { pageId: string }) => r.pageId)).toEqual([p1.id]);
    expect((await search('red banana')).body).toHaveLength(0);
  });

  it('returns breadcrumbs and highlighted snippets', async () => {
    const nb = await b.notebook('Physics');
    const cat = await b.category(nb.id, 'Mechanics');
    const page = await b.page(cat.id, 'Newton');
    await write(page.id, 'Force equals mass times acceleration.');
    const [hit] = (await search('acceleration')).body;
    expect(hit).toMatchObject({ pageId: page.id, notebookName: 'Physics', categoryName: 'Mechanics', title: 'Newton' });
    expect(hit.snippet).toContain('[[acceleration]]');
  });

  it('ranks a title match above a body-only match', async () => {
    const cat = await b.category((await b.notebook()).id);
    const body = await b.page(cat.id, 'Shopping');
    const title = await b.page(cat.id, 'Gravity notes');
    await write(body.id, 'remember the gravity lecture');
    await write(title.id, 'nothing relevant here');
    const ids = (await search('gravity')).body.map((r: { pageId: string }) => r.pageId);
    expect(ids).toEqual([title.id, body.id]);
  });

  it('finds words that only appear inside math, diagrams and chart labels', async () => {
    const cat = await b.category((await b.notebook()).id);
    const page = await b.page(cat.id, 'Mixed');
    const res = await t.http.post(`/api/pages/${page.id}/snapshots/replace`).set(me.auth).send({
      baseVersion: 0,
      content: {
        type: 'doc',
        content: [
          { type: 'mermaid', attrs: { code: 'graph TD\n  Photosynthesis --> Glucose' } },
          { type: 'chart', attrs: { type: 'bar', data: { labels: ['Mitochondria'], datasets: [{ label: 'Energy', data: [1] }] }, options: {} } },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect((await search('photosynthesis')).body).toHaveLength(1);
    expect((await search('mitochondria')).body).toHaveLength(1);
  });

  it('never returns another user’s pages, trashed pages, or pages in a trashed notebook', async () => {
    const nb = await b.notebook();
    const cat = await b.category(nb.id);
    const mine = await b.page(cat.id, 'secret plans');
    const trashed = await b.page(cat.id, 'secret trash');
    await write(mine.id, 'confidential');
    await write(trashed.id, 'confidential');
    await t.http.delete(`/api/pages/${trashed.id}`).set(me.auth);

    const eve = await signup(t);
    expect((await search('confidential', eve)).body).toEqual([]);
    expect((await search('confidential')).body.map((r: { pageId: string }) => r.pageId)).toEqual([mine.id]);

    await t.http.delete(`/api/notebooks/${nb.id}`).set(me.auth);
    expect((await search('confidential')).body).toEqual([]);
  });

  it('can be limited to one notebook', async () => {
    const n1 = await b.notebook('One');
    const n2 = await b.notebook('Two');
    const p1 = await b.page((await b.category(n1.id)).id, 'a');
    const p2 = await b.page((await b.category(n2.id)).id, 'b');
    await write(p1.id, 'shared keyword');
    await write(p2.id, 'shared keyword');
    expect((await search('keyword')).body).toHaveLength(2);
    const scoped = await search('keyword', me, `&notebookId=${n2.id}`);
    expect(scoped.body.map((r: { pageId: string }) => r.pageId)).toEqual([p2.id]);
  });

  it('is safe against operator injection and degenerate input', async () => {
    const cat = await b.category((await b.notebook()).id);
    const page = await b.page(cat.id, 'p');
    await write(page.id, 'harmless content');
    for (const q of ['+-*()<>~@"', '"unterminated', "'; DROP TABLE Page; --", 'a', '   ', '*']) {
      const res = await search(q);
      expect(res.status, `query ${JSON.stringify(q)}`).toBe(q.trim() === '' ? 400 : 200);
      if (res.status === 200) expect(Array.isArray(res.body)).toBe(true);
    }
    expect(await t.prisma.page.count()).toBe(1); // the table is still there
  });

  it('validates the query string', async () => {
    expect((await t.http.get('/api/search').set(me.auth)).status).toBe(400);
    expect((await t.http.get('/api/search?q=x&limit=500').set(me.auth)).status).toBe(400);
    expect((await t.http.get('/api/search?q=hello')).status).toBe(401);
  });
});
