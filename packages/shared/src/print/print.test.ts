import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { chartJsConfig } from '../schema';
import { IMG_ID, VID_ID, richDoc } from '../doc/fixtures';
import { renderPrintHtml, type PrintEntry } from './render';
import { printCss } from './styles';

const POSTER = '0192f0a4-7c1e-7b3a-9d2e-3f4a5b6c7d90';
const para = (text: string): JSONContent => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

const render = (entries: PrintEntry[], over: Partial<Parameters<typeof renderPrintHtml>[0]> = {}) =>
  renderPrintHtml({
    title: 'My notebook',
    entries,
    locale: 'en',
    pageSize: 'A4',
    cover: true,
    includeToc: true,
    mediaUrl: (id) => `https://export.invalid/media/${id}`,
    ...over,
  });

describe('renderPrintHtml', () => {
  const entries: PrintEntry[] = [
    { kind: 'category', id: 'c1', name: 'Basics & <more>', depth: 0 },
    { kind: 'page', id: 'p1', title: 'Rich', doc: richDoc(), depth: 1 },
    { kind: 'page', id: 'p2', title: '', doc: para('plain'), depth: 1 },
  ];

  it('builds a cover, a table of contents with anchors, and a section per page', () => {
    const html = render(entries);
    expect(html).toContain('class="cover"');
    expect(html).toContain('<h1>My notebook</h1>');
    expect(html).toContain('class="toc"');
    expect(html).toContain('href="#p-p1"');
    expect(html).toContain('id="p-p1"');
    expect(html).toContain('id="c-c1"');
    expect(html.match(/<section class="page"/g)).toHaveLength(2);
  });

  it('escapes titles and falls back to a label for untitled pages', () => {
    const html = render(entries);
    expect(html).toContain('Basics &amp; &lt;more&gt;');
    expect(html).not.toContain('Basics & <more>');
    expect(html).toContain('Untitled');
    expect(render(entries, { locale: 'pt' })).toContain('Sem título');
  });

  it('can omit the cover and the table of contents', () => {
    const html = render(entries, { cover: false, includeToc: false });
    expect(html).not.toContain('class="cover"');
    expect(html).not.toContain('class="toc"');
  });

  it('points images at the resolver and shows a video as its poster frame', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'imageFigure', attrs: { mediaId: IMG_ID, alt: 'pic', caption: 'Cap', width: 50, align: 'center' } },
        { type: 'video', attrs: { mediaId: VID_ID, posterId: POSTER, caption: '', width: null } },
        { type: 'video', attrs: { mediaId: VID_ID, posterId: null, caption: '', width: null } },
      ],
    };
    const html = render([{ kind: 'page', id: 'p', title: 'T', doc, depth: 0 }]);
    expect(html).toContain(`src="https://export.invalid/media/${IMG_ID}"`);
    expect(html).toContain(`src="https://export.invalid/media/${POSTER}"`); // the poster, never the video file
    expect(html).not.toContain(`media/${VID_ID}`);
    expect(html).not.toContain('<video');
    expect(html).toContain('video-placeholder'); // the one without a poster
  });

  it('demotes headings inside a page because the page title is the H1', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Top' }] },
        { type: 'heading', attrs: { level: 6 }, content: [{ type: 'text', text: 'Deep' }] },
      ],
    };
    const html = render([{ kind: 'page', id: 'p', title: 'T', doc, depth: 0 }]);
    expect(html).toContain('<h2>Top</h2>');
    expect(html).toContain('<h6>Deep</h6>'); // capped at 6
  });

  it('replaces YouTube iframes with a link, since nothing can load inside a PDF', () => {
    const src = 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ';
    const html = render([{ kind: 'page', id: 'p', title: 'T', doc: { type: 'doc', content: [{ type: 'youtube', attrs: { src } }] }, depth: 0 }]);
    expect(html).not.toContain('<iframe');
    expect(html).toContain(`<a href="${src}">`);
  });

  it('opens no network connections of its own: only the print origin is referenced as a resource', () => {
    const html = render(entries, { assetsBase: 'https://export.invalid/static/' });
    const resources = [...html.matchAll(/\s(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]!).filter((u) => !/^https?:\/\/(?:www\.)?example\.com/.test(u));
    // links the author wrote (example.com in the fixture) are fine; everything loaded must be local
    for (const u of resources.filter((u) => !u.startsWith('https://export.invalid/'))) {
      expect(html, `non-local URL ${u} must only be a link`).toContain(`<a href="${u}"`);
    }
    expect(html).toContain('https://export.invalid/static/notes-libs.js');
    expect(html).toContain('https://export.invalid/static/print-runtime.js');
    expect(html.indexOf('notes-libs.js')).toBeLessThan(html.indexOf('print-runtime.js')); // libraries first
    expect(html).toContain('https://export.invalid/static/katex/katex.min.css');
  });

  it('is static (no scripts) when no assets are given', () => {
    expect(render(entries)).not.toContain('<script');
  });

  it('prints the page size into the stylesheet', () => {
    expect(render(entries, { pageSize: 'Letter' })).toContain('size: Letter');
    expect(render(entries)).toContain('size: A4');
  });
});

describe('render config shared by the editor and the print runtime', () => {
  const data = { labels: ['A', 'B'], datasets: [{ label: 'S1', data: [1, 2] }, { label: 'S2', data: [3, 4], color: '#123456' }] };

  it('colours series from the palette unless the author chose a colour', () => {
    const cfg = chartJsConfig('bar', data, {});
    expect(cfg.data.datasets[0]!.backgroundColor).toBe('#3b5bdb');
    expect(cfg.data.datasets[1]!.backgroundColor).toBe('#123456');
  });

  it('colours each slice for pie and doughnut charts, and has no axes', () => {
    const cfg = chartJsConfig('pie', data, {});
    expect(cfg.data.datasets[0]!.backgroundColor).toHaveLength(2);
    expect('scales' in cfg.options).toBe(false);
  });

  it('turns the labels of a scatter chart into x values', () => {
    const cfg = chartJsConfig('scatter', { labels: ['1', '2.5', 'n/a'], datasets: [{ label: 'S', data: [10, 20, 30] }] }, {});
    expect(cfg.data.datasets[0]!.data).toEqual([{ x: 1, y: 10 }, { x: 2.5, y: 20 }, { x: 2, y: 30 }]);
  });

  it('turns animation off for printing but not for the live editor', () => {
    expect(chartJsConfig('line', data, {}, { animate: false }).options.animation).toBe(false);
    expect(chartJsConfig('line', data, {}, { animate: true }).options.animation).toBeUndefined();
  });

});

describe('print output and themes', () => {
  // The app's colour themes (dark, purple, ...) are CSS on the page. Paper is always light: the print document must
  // be self-contained, so that exporting from any theme produces the same PDF.
  it('uses no theme variables, theme attributes or dark colour scheme', () => {
    const html = renderPrintHtml({
      title: 'Themes',
      entries: [{ kind: 'page', id: 'p1', title: 'Rich', doc: richDoc(), depth: 0 }],
      locale: 'en',
      pageSize: 'A4',
      cover: true,
      includeToc: true,
      mediaUrl: (id) => `https://export.invalid/media/${id}`,
    });
    for (const text of [html, printCss('A4'), printCss('Letter')]) {
      expect(text).not.toMatch(/var\(--/);
      expect(text).not.toMatch(/data-theme/);
      expect(text).not.toMatch(/prefers-color-scheme/);
      expect(text).not.toMatch(/color-scheme:\s*dark/);
    }
  });
});
