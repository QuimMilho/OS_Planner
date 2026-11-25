import { describe, expect, it } from 'vitest';
import { generateHTML } from '@tiptap/html';
import type { JSONContent } from '@tiptap/core';
import { getSchemaExtensions } from '../schema';
import { extractText, countWords, collectMediaIds } from './text';
import { validateDoc } from './validate';
import { docToMarkdown, markdownToDoc } from './markdown';
import { IMG_ID, richDoc } from './fixtures';

const para = (text: string, marks?: JSONContent['marks']): JSONContent => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text, marks }] }],
});

describe('validateDoc', () => {
  it('accepts a document that uses every node type', () => {
    const res = validateDoc(richDoc());
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
  });

  it('returns the normalised document, dropping unknown attributes', () => {
    const doc = para('hi');
    (doc.content![0] as any).attrs = { evil: '<script>', textAlign: 'left' };
    const res = validateDoc(doc);
    expect(res.ok).toBe(true);
    if (res.ok) expect(JSON.stringify(res.doc)).not.toContain('evil');
  });

  it('rejects unknown node types', () => {
    const res = validateDoc({ type: 'doc', content: [{ type: 'script' }] });
    expect(res.ok).toBe(false);
  });

  it('rejects content that violates the schema structure', () => {
    // a listItem directly under the doc is not allowed
    const res = validateDoc({ type: 'doc', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] });
    expect(res.ok).toBe(false);
  });

  it('rejects a non-doc root', () => {
    expect(validateDoc({ type: 'paragraph' }).ok).toBe(false);
    expect(validateDoc(null).ok).toBe(false);
    expect(validateDoc('x').ok).toBe(false);
  });

  it.each(['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '//evil.example.com'])(
    'rejects unsafe link %s',
    (href) => {
      const res = validateDoc(para('x', [{ type: 'link', attrs: { href } }]));
      expect(res.ok).toBe(false);
    },
  );

  it.each(['https://a.example/x?y=1', 'mailto:a@b.co', 'tel:+351123456', '#section', '/app/p/123'])(
    'accepts safe link %s',
    (href) => {
      const res = validateDoc(para('x', [{ type: 'link', attrs: { href } }]));
      expect(res.ok, res.ok ? '' : res.error).toBe(true);
    },
  );

  it('rejects CSS injection through text colour', () => {
    const bad = para('x', [{ type: 'textStyle', attrs: { color: 'red; position: fixed; inset: 0' } }]);
    expect(validateDoc(bad).ok).toBe(false);
    const good = para('x', [{ type: 'textStyle', attrs: { color: '#ff8800' } }]);
    expect(validateDoc(good).ok).toBe(true);
  });

  it('requires media ids to be uuids', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [{ type: 'imageFigure', attrs: { mediaId: '../../etc/passwd', alt: '', caption: '', width: null, align: 'center' } }],
    };
    expect(validateDoc(doc).ok).toBe(false);
  });

  it('only allows YouTube embeds', () => {
    const mk = (src: string): JSONContent => ({ type: 'doc', content: [{ type: 'youtube', attrs: { src } }] });
    expect(validateDoc(mk('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')).ok).toBe(true);
    expect(validateDoc(mk('https://evil.example/embed/x')).ok).toBe(false);
    expect(validateDoc(mk('javascript:alert(1)')).ok).toBe(false);
  });

  it('restricts plot expressions to arithmetic characters', () => {
    const mk = (fn: string): JSONContent => ({
      type: 'doc',
      content: [
        {
          type: 'functionPlot',
          attrs: { expressions: [{ kind: 'linear', fn }], xDomain: [-1, 1], yDomain: null, grid: true, title: '' },
        },
      ],
    });
    expect(validateDoc(mk('sin(x)^2 + 3*x')).ok).toBe(true);
    expect(validateDoc(mk('constructor.constructor("alert(1)")()')).ok).toBe(false);
    expect(validateDoc(mk('x; y')).ok).toBe(false);
    expect(validateDoc(mk('__proto__')).ok).toBe(false);
  });

  it('rejects absurdly deep documents', () => {
    let node: JSONContent = { type: 'paragraph' };
    for (let i = 0; i < 60; i++) node = { type: 'blockquote', content: [node] };
    expect(validateDoc({ type: 'doc', content: [node] }).ok).toBe(false);
  });
});

describe('extractText', () => {
  it('includes the searchable parts of rich blocks', () => {
    const text = extractText(richDoc());
    expect(text).toContain('Física 101');
    expect(text).toContain('E=mc^2'); // inline math
    expect(text).toContain('A-->B'); // mermaid source
    expect(text).toContain('Vendas'); // chart dataset label
    expect(text).toContain('Jan'); // chart label
    expect(text).toContain('sin(x)/x'); // plot expression
    expect(text).toContain('Figure 1'); // caption
  });

  it('separates blocks with newlines', () => {
    const text = extractText({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
      ],
    });
    expect(text).toBe('one\ntwo');
  });

  it('counts accented words', () => {
    expect(countWords('Olá, mundo! É a vida-real.')).toBe(5);
  });

  it('collects media ids from images and videos, deduplicated, including nested blocks', () => {
    const doc = richDoc();
    const nested: JSONContent = {
      type: 'callout',
      attrs: { variant: 'info' },
      content: [{ type: 'imageFigure', attrs: { mediaId: IMG_ID, alt: '', caption: '', width: null, align: 'center' } }],
    };
    doc.content!.push(nested);
    const ids = collectMediaIds(doc);
    expect(ids).toContain(IMG_ID);
    expect(ids.filter((i) => i === IMG_ID)).toHaveLength(1);
    expect(ids).toHaveLength(2); // image + video
    expect(collectMediaIds({ type: 'doc', content: [{ type: 'paragraph' }] })).toEqual([]);
  });
});

describe('HTML rendering (print path)', () => {
  const html = generateHTML(richDoc(), getSchemaExtensions());

  it('renders the standard nodes', () => {
    expect(html).toContain('<h1>Física 101</h1>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<table');
  });

  it('renders custom nodes as placeholders for the print runtime', () => {
    expect(html).toContain('data-type="mermaid"');
    expect(html).toContain('graph TD');
    expect(html).toContain('data-type="chart"');
    expect(html).toContain('data-type="function-plot"');
    expect(html).toContain(`data-media-id="${IMG_ID}"`);
    expect(html).toContain('<figcaption>Figure 1</figcaption>');
    expect(html).toContain('data-type="callout"');
  });

  it('renders math as elements carrying the latex source', () => {
    expect(html).toContain('E=mc^2');
  });
});

describe('Markdown interop', () => {
  const md = docToMarkdown(richDoc(), { mediaPath: (id) => `media/${id}.png` });

  it('exports standard content', () => {
    expect(md).toContain('# Física 101');
    expect(md).toContain('**bold**');
    expect(md).toContain('[link](https://example.com)');
    expect(md).toContain('- one');
    expect(md).toContain('```typescript');
  });

  it('exports custom blocks as fenced code and alerts', () => {
    expect(md).toContain('```mermaid\ngraph TD\n  A-->B\n```');
    expect(md).toContain('```chart');
    expect(md).toContain('```plot');
    expect(md).toContain('> [!WARNING]');
    expect(md).toContain(`![Diagram](media/${IMG_ID}.png "Figure 1")`);
  });

  it('round-trips rich blocks back into custom nodes', () => {
    const back = markdownToDoc(md);
    expect(back.ok, back.ok ? '' : back.error).toBe(true);
    if (!back.ok) return;
    const types = (back.doc.content ?? []).map((n) => n.type);
    expect(types).toContain('heading');
    expect(types).toContain('mermaid');
    expect(types).toContain('chart');
    expect(types).toContain('functionPlot');
    expect(types).toContain('callout');
    expect(types).toContain('imageFigure');
    const chart = back.doc.content!.find((n) => n.type === 'chart')!;
    expect(chart.attrs!['data']).toEqual(richDoc().content!.find((n) => n.type === 'chart')!.attrs!['data']);
    const callout = back.doc.content!.find((n) => n.type === 'callout')!;
    expect(callout.attrs!['variant']).toBe('warning');
    expect(JSON.stringify(callout)).toContain('Careful here');
    expect(JSON.stringify(callout)).not.toContain('[!WARNING]');
  });

  it('imports plain markdown', () => {
    const res = markdownToDoc('# Title\n\nHello **world** and `code`.\n\n- a\n- b\n\n1. x\n2. y\n');
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (res.ok) {
      const types = res.doc.content!.map((n) => n.type);
      expect(types).toEqual(['heading', 'paragraph', 'bulletList', 'orderedList']);
    }
  });

  it('keeps invalid chart/plot fences as ordinary code blocks', () => {
    const res = markdownToDoc('```chart\nnot json\n```\n');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.doc.content![0]!.type).toBe('codeBlock');
  });

  it('degrades remote images to links instead of failing', () => {
    const res = markdownToDoc('Look: ![logo](https://example.com/logo.png) done\n');
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (res.ok) expect(JSON.stringify(res.doc)).toContain('https://example.com/logo.png');
  });

  it('never produces a document that fails validation, even for hostile input', () => {
    const hostile = '<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![a](javascript:alert(1))\n';
    const res = markdownToDoc(hostile);
    if (res.ok) expect(JSON.stringify(res.doc)).not.toContain('javascript:');
  });
});
