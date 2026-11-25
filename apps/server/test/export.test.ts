import { unzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// pdfjs ships a Node-friendly "legacy" build
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { findChrome } from '../src/export/chrome.js';
import { createTestApp, type TestApp } from './app.js';
import { png } from './fixtures.js';
import { builders, para, signup, uuid, type Account } from './helpers.js';

const haveChrome = findChrome({ CHROME_PATH: process.env.CHROME_PATH || undefined }) !== null;

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

const bin = (res: { body: unknown }) => res.body as Buffer;
const binary = (r: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  r.on('data', (c: Buffer) => chunks.push(c));
  r.on('end', () => cb(null, Buffer.concat(chunks)));
};

async function pdfInfo(buffer: Buffer) {
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  const outline = (await doc.getOutline()) as { title: string }[] | null;
  return { numPages: doc.numPages, pages, text: pages.join('\n'), flat: pages.join('').replace(/\s+/g, ''), outline };
}

const putContent = async (pageId: string, content: unknown, baseVersion = 0) => {
  const res = await t.http.put(`/api/pages/${pageId}/content`).set(me.auth).send({ content, baseVersion });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
};

const uploadImage = async () => {
  const id = uuid();
  const res = await t.http.post('/api/media').set(me.auth).field('id', id).attach('file', await png(120, 60, '#2f9e44'), 'a.png');
  expect(res.status).toBe(201);
  return id;
};

const exportPdf = (body: object, who = me) =>
  t.http.post('/api/export/pdf').set(who.auth).send(body).buffer(true).parse(binary);

describe.skipIf(!haveChrome)('PDF export (headless Chrome)', () => {
  it('renders a page: text, accents, math, diagrams, plots, tables and code all reach the PDF', async () => {
    const cat = await b.category((await b.notebook('Ciência')).id, 'Física');
    const page = await b.page(cat.id, 'Física Quântica');
    const image = await uploadImage();
    await putContent(page.id, {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Introdução' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'A acentuação é preservada. Energia: ' }, { type: 'inlineMath', attrs: { latex: 'E=mc^2' } }] },
        { type: 'blockMath', attrs: { latex: '\\int_0^1 x^2\\,dx = \\tfrac{1}{3}' } },
        { type: 'codeBlock', attrs: { language: 'typescript' }, content: [{ type: 'text', text: 'const photon = emit();' }] },
        { type: 'callout', attrs: { variant: 'warning' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cuidado com a medição' }] }] },
        { type: 'mermaid', attrs: { code: 'graph TD\n  Photosynthesis --> Glucose' } },
        { type: 'functionPlot', attrs: { expressions: [{ kind: 'linear', fn: 'sin(x)/x' }], xDomain: [-10, 10], yDomain: null, grid: true, title: 'Sinc function' } },
        { type: 'chart', attrs: { type: 'bar', data: { labels: ['Jan', 'Fev'], datasets: [{ label: 'Vendas', data: [3, 5] }] }, options: { title: 'Resultados' } } },
        { type: 'imageFigure', attrs: { mediaId: image, alt: 'verde', caption: 'Figura um', width: 50, align: 'center' } },
        {
          type: 'table',
          content: [
            { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Partícula' }] }] }] },
            { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Fotão' }] }] }] },
          ],
        },
      ],
    });

    const res = await exportPdf({ scope: 'page', id: page.id, locale: 'pt' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain(encodeURIComponent('Física Quântica.pdf'));
    const pdf = bin(res);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

    const info = await pdfInfo(pdf);
    expect(info.text).toContain('Física Quântica'); // page title
    expect(info.text).toContain('Introdução'); // heading
    expect(info.text).toContain('acentuação'); // accents survive
    expect(info.flat).toContain('E=mc2'); // KaTeX drew the inline formula
    expect(info.text).toContain('Cuidado com a medição'); // callout
    expect(info.text).toContain('photon'); // code
    expect(info.text).toContain('Photosynthesis'); // mermaid diagram was rendered
    expect(info.text).toContain('Sinc function'); // function plot title
    expect(info.text).toContain('Figura um'); // image caption
    expect(info.text).toContain('Fotão'); // table
    expect(info.text).not.toContain('graph TD'); // the diagram source is not printed
    expect(info.text).not.toContain('\\int'); // formulas are typeset, not shown as LaTeX
  });

  it('a single page has no cover or table of contents', async () => {
    const page = await b.page((await b.category((await b.notebook()).id)).id, 'Only page');
    await putContent(page.id, para('hello'));
    const info = await pdfInfo(bin(await exportPdf({ scope: 'page', id: page.id })));
    expect(info.numPages).toBe(1);
    expect(info.text).not.toContain('Contents');
  });

  it('a notebook gets a cover, a table of contents, category dividers, and one page per note', async () => {
    const nb = await b.notebook('Quantum Course');
    const a = await b.category(nb.id, 'Basics');
    const sub = await b.category(nb.id, 'Advanced', a.id);
    const p1 = await b.page(a.id, 'Wave functions');
    const p2 = await b.page(sub.id, 'Entanglement');
    await putContent(p1.id, para('psi of x'));
    await putContent(p2.id, para('spooky action'));
    const trashed = await b.page(a.id, 'Trashed note');
    await putContent(trashed.id, para('should not appear'));
    await t.http.delete(`/api/pages/${trashed.id}`).set(me.auth);

    const info = await pdfInfo(bin(await exportPdf({ scope: 'notebook', id: nb.id, includeToc: true })));
    // cover + toc + (General category divider) + Basics divider + page + Advanced divider + page, at least
    expect(info.numPages).toBeGreaterThanOrEqual(6);
    expect(info.pages[0]).toContain('Quantum Course');
    expect(info.pages[1]).toContain('Contents');
    for (const entry of ['Basics', 'Advanced', 'Wave functions', 'Entanglement']) expect(info.pages[1]).toContain(entry);
    expect(info.text).toContain('spooky action');
    expect(info.text).not.toContain('Trashed note');
    expect(info.text).not.toContain('should not appear');
    // headings become PDF bookmarks
    expect(info.outline?.map((o) => o.title)).toEqual(expect.arrayContaining(['Wave functions', 'Entanglement']));
    // reading order: a category's pages come before its subcategories
    expect(info.text.indexOf('psi of x')).toBeLessThan(info.text.indexOf('spooky action'));
  });

  it('can leave out the table of contents, and a category export covers only that subtree', async () => {
    const nb = await b.notebook('Everything');
    const mine = await b.category(nb.id, 'Mine');
    const other = await b.category(nb.id, 'Other');
    await putContent((await b.page(mine.id, 'In scope')).id, para('wanted text'));
    await putContent((await b.page(other.id, 'Out of scope')).id, para('unwanted text'));

    const info = await pdfInfo(bin(await exportPdf({ scope: 'category', id: mine.id, includeToc: false })));
    expect(info.text).toContain('wanted text');
    expect(info.text).not.toContain('unwanted text');
    expect(info.text).not.toContain('Contents');
  });

  it('uses Portuguese labels and Letter paper on request', async () => {
    const nb = await b.notebook('Caderno');
    const page = await b.page((await b.category(nb.id)).id, 'Uma página');
    await putContent(page.id, para('texto'));
    const info = await pdfInfo(bin(await exportPdf({ scope: 'notebook', id: nb.id, locale: 'pt', pageSize: 'Letter' })));
    expect(info.text).toContain('Índice');
    expect(info.text).toContain('Exportado em');
  });

  it('renders several exports at once without mixing them up', async () => {
    const pages = await Promise.all(
      ['alpha', 'bravo', 'charlie', 'delta'].map(async (word) => {
        const p = await b.page((await b.category((await b.notebook(word)).id)).id, `page ${word}`);
        await putContent(p.id, para(`unique ${word} content`));
        return { id: p.id, word };
      }),
    );
    const results = await Promise.all(pages.map((p) => exportPdf({ scope: 'page', id: p.id }).then(async (r) => ({ word: p.word, status: r.status, info: await pdfInfo(bin(r)) }))));
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.info.text).toContain(`unique ${r.word} content`);
      for (const other of results.filter((o) => o.word !== r.word)) expect(r.info.text).not.toContain(`unique ${other.word} content`);
    }
  });

  it('cannot be used to read a media file belonging to someone else', async () => {
    // A picture with an unusual size: an embedded copy shows up in the PDF as "/Width 41 /Height 67".
    // (A broken <img> also draws an icon, so merely counting images would prove nothing.)
    const secretPng = await png(41, 67, '#ff0000');
    const embedded = (pdf: Buffer) => /\/Width\s+41\b/.test(pdf.toString('latin1')) && /\/Height\s+67\b/.test(pdf.toString('latin1'));
    const withImage = (mediaId: string) => ({ type: 'doc', content: [{ type: 'imageFigure', attrs: { mediaId, alt: 'stolen', caption: '', width: null, align: 'center' } }] });

    const eve = await signup(t);
    const eveImage = uuid();
    expect((await t.http.post('/api/media').set(eve.auth).field('id', eveImage).attach('file', secretPng, 'secret.png')).status).toBe(201);
    const mineImage = uuid();
    expect((await t.http.post('/api/media').set(me.auth).field('id', mineImage).attach('file', secretPng, 'mine.png')).status).toBe(201);

    const cat = await b.category((await b.notebook()).id);
    const control = await b.page(cat.id, 'Control');
    const sneaky = await b.page(cat.id, 'Sneaky');
    await putContent(control.id, withImage(mineImage));
    // The API refuses a reference to someone else's media, so plant it directly to test the renderer's own defence.
    await t.prisma.page.update({ where: { id: sneaky.id }, data: { content: withImage(eveImage) } });

    // Positive control: the detector does see the user's own image...
    expect(embedded(bin(await exportPdf({ scope: 'page', id: control.id })))).toBe(true);
    // ...and does not see someone else's.
    const res = await exportPdf({ scope: 'page', id: sneaky.id });
    expect(res.status).toBe(200); // it renders, with the image simply missing
    expect(embedded(bin(res))).toBe(false);
    expect((await pdfInfo(bin(res))).text).toContain('stolen'); // the broken image shows its alt text
  });
});

describe('PDF export access control', () => {
  it('needs a verified email', async () => {
    const unverified = await signup(t, false);
    const nb = await builders(t, unverified).notebook();
    const res = await t.http.post('/api/export/pdf').set(unverified.auth).send({ scope: 'notebook', id: nb.id });
    expect(res.status).toBe(403);
  });

  it('answers 404 for things that are not yours, and validates input', async () => {
    const nb = await b.notebook();
    const eve = await signup(t);
    expect((await t.http.post('/api/export/pdf').set(eve.auth).send({ scope: 'notebook', id: nb.id })).status).toBe(404);
    expect((await t.http.post('/api/export/pdf').set(me.auth).send({ scope: 'notebook', id: uuid() })).status).toBe(404);
    expect((await t.http.post('/api/export/pdf').set(me.auth).send({ scope: 'galaxy', id: nb.id })).status).toBe(400);
    expect((await t.http.post('/api/export/pdf').send({ scope: 'notebook', id: nb.id })).status).toBe(401);
  });

  it('reports 503 pdf_unavailable when the server has no browser, so the app can print locally', async () => {
    const saved = process.env.CHROME_PATH;
    process.env.CHROME_PATH = process.platform === 'win32' ? 'C:\\definitely\\missing\\chrome.exe' : '/definitely/missing/chrome';
    const noChrome = await createTestApp();
    try {
      const acct = await signup(noChrome);
      const bb = builders(noChrome, acct);
      const page = await bb.page((await bb.category((await bb.notebook()).id)).id);
      const res = await noChrome.http.post('/api/export/pdf').set(acct.auth).send({ scope: 'page', id: page.id });
      expect(res.status).toBe(503);
      expect(res.body.message).toBe('pdf_unavailable');
    } finally {
      await noChrome.close();
      if (saved === undefined) delete process.env.CHROME_PATH;
      else process.env.CHROME_PATH = saved;
    }
  });
});

describe('Markdown export', () => {
  const exportMd = (scope: string, id: string, who = me) =>
    t.http.get(`/api/export/markdown?scope=${scope}&id=${id}`).set(who.auth).buffer(true).parse(binary);
  const unzip = (res: { body: unknown }) => unzipSync(new Uint8Array(bin(res)));

  it('exports one page without media as a plain .md file', async () => {
    const page = await b.page((await b.category((await b.notebook()).id)).id, 'Notas: "rápidas"?');
    await putContent(page.id, {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Título' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'negrito', marks: [{ type: 'bold' }] }] },
        { type: 'mermaid', attrs: { code: 'graph TD\n  A-->B' } },
      ],
    });
    const res = await exportMd('page', page.id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    // characters that are illegal in file names are replaced, accents kept
    expect(res.headers['content-disposition']).toContain(encodeURIComponent('Notas_ _rápidas__.md'));
    const md = bin(res).toString('utf8');
    expect(md).toContain('## Título');
    expect(md).toContain('**negrito**');
    expect(md).toContain('```mermaid\ngraph TD\n  A-->B\n```');
  });

  it('exports a page with images as a zip with a relative media link that works', async () => {
    const page = await b.page((await b.category((await b.notebook()).id)).id, 'Com imagem');
    const image = await uploadImage();
    await putContent(page.id, { type: 'doc', content: [{ type: 'imageFigure', attrs: { mediaId: image, alt: 'verde', caption: 'Legenda', width: null, align: 'center' } }] });
    const res = await exportMd('page', page.id);
    expect(res.headers['content-type']).toBe('application/zip');
    const files = unzip(res);
    expect(Object.keys(files).sort()).toEqual([`Com imagem/Com imagem.md`, `Com imagem/media/${image}.png`].sort());
    expect(strFromU8(files['Com imagem/Com imagem.md']!)).toContain(`![verde](media/${image}.png "Legenda")`);
    expect(files[`Com imagem/media/${image}.png`]!.subarray(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47])); // a real PNG
  });

  it('exports a notebook as a folder tree, with unique names and media one level up', async () => {
    const nb = await b.notebook('Meu Caderno');
    const top = await b.category(nb.id, 'Física');
    const sub = await b.category(nb.id, 'Óptica', top.id);
    const image = await uploadImage();
    const p1 = await b.page(top.id, 'Intro');
    const p2 = await b.page(top.id, 'Intro'); // same title: must not overwrite
    const p3 = await b.page(sub.id, 'Lentes');
    for (const [p, text] of [[p1, 'primeira'], [p2, 'segunda']] as const) await putContent(p.id, para(text));
    await putContent(p3.id, { type: 'doc', content: [{ type: 'imageFigure', attrs: { mediaId: image, alt: '', caption: '', width: null, align: 'center' } }] });

    const files = unzip(await exportMd('notebook', nb.id));
    const names = Object.keys(files);
    expect(names).toContain('Meu Caderno/Física/Intro.md');
    expect(names).toContain('Meu Caderno/Física/Intro (2).md');
    expect(names).toContain('Meu Caderno/Física/Óptica/Lentes.md'); // accents in names survive the zip
    expect(names).toContain(`Meu Caderno/media/${image}.png`);
    // two folders deep from the root, so the image link climbs two levels
    expect(strFromU8(files['Meu Caderno/Física/Óptica/Lentes.md']!)).toContain(`](../../media/${image}.png)`);
    expect(strFromU8(files['Meu Caderno/Física/Intro.md']!)).toContain('primeira');
    expect(strFromU8(files['Meu Caderno/Física/Intro (2).md']!)).toContain('segunda');
  });

  it('is limited to what the user owns', async () => {
    const nb = await b.notebook();
    const eve = await signup(t);
    expect((await exportMd('notebook', nb.id, eve)).status).toBe(404);
  });
});
