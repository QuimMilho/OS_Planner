import { describe, expect, it } from 'vitest';
import { HOSTILE_MARKDOWN, SAFE_HREFS, UNSAFE_HREFS } from '../doc/hostile';
import {
  chatMarkdownToHtml,
  chatMarkdownToText,
  parseChatMarkdown,
  parseInline,
  type Block,
  type Inline,
} from './markdown';

/** Every link target in a parsed message. */
function hrefs(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  const inline = (nodes: readonly Inline[]): void => {
    for (const n of nodes) {
      if (n.t === 'link') out.push(n.href);
      if ('c' in n) inline(n.c);
    }
  };
  const block = (b: Block): void => {
    if (b.t === 'p' || b.t === 'h') inline(b.c);
    else if (b.t === 'quote') b.c.forEach(block);
    else if (b.t === 'ul' || b.t === 'ol') b.items.forEach((item) => item.forEach(block));
  };
  blocks.forEach(block);
  return out;
}

describe('chat Markdown: safety', () => {
  it.each(HOSTILE_MARKDOWN)('turns %j into text and fixed elements only', (src) => {
    const html = chatMarkdownToHtml(src);
    // every "<" is part of one of the elements we make ourselves; none comes from the message
    const tags = [...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]);
    for (const tag of tags)
      expect([
        'p',
        'h1',
        'h2',
        'h3',
        'blockquote',
        'ul',
        'ol',
        'li',
        'pre',
        'code',
        'strong',
        'em',
        'del',
        'a',
        'br',
        'hr',
      ]).toContain(tag);
    expect(html).not.toMatch(/<(script|img|iframe|svg|style)\b|<b[ >]/i);
    expect(html.toLowerCase()).not.toMatch(/href="(javascript|data|vbscript)/);
    // an event handler can only appear as harmless text, never as an attribute
    expect(html).not.toMatch(/<[^>]+\son\w+=/i);
  });

  it.each(UNSAFE_HREFS)('does not make a link of %j', (href) => {
    expect(hrefs(parseChatMarkdown(`[click](${href})`))).toEqual([]);
    expect(hrefs(parseChatMarkdown(`[click](<${href}>)`))).toEqual([]);
  });

  it.each(SAFE_HREFS)('links %j', (href) => {
    expect(hrefs(parseChatMarkdown(`[go](${href})`))).toEqual([href]);
  });

  it('escapes what it prints, quotes included', () => {
    const html = chatMarkdownToHtml('"quoted" & <b>raw</b> \'single\'');
    expect(html).toBe('<p>&quot;quoted&quot; &amp; &lt;b&gt;raw&lt;/b&gt; &#39;single&#39;</p>');
  });

  it('does not support images: the text stays and the address is not followed', () => {
    const html = chatMarkdownToHtml('![logo](https://example.com/logo.png)');
    expect(html).not.toContain('<img');
    expect(html).toContain('logo');
  });

  it('puts rel on links and never lets a title attribute carry a handler', () => {
    const html = chatMarkdownToHtml('[a](https://ok.example "title\\" onmouseover=\\"alert(1)")');
    expect(html).not.toMatch(/onmouseover=/);
    const ok = chatMarkdownToHtml('[a](https://ok.example)');
    expect(ok).toContain('rel="noopener noreferrer nofollow"');
  });

  it('stays fast on input made to be slow', () => {
    const inputs = [
      '*'.repeat(30_000),
      '_*~'.repeat(8_000),
      '['.repeat(15_000),
      '`'.repeat(15_000),
      '> '.repeat(5_000) + 'x',
      '- '.repeat(8_000),
      '**a '.repeat(5_000),
      '[a](' + 'b'.repeat(19_000),
    ];
    for (const src of inputs) {
      const t0 = performance.now();
      parseChatMarkdown(src);
      expect(performance.now() - t0, src.slice(0, 12)).toBeLessThan(1500);
    }
  });

  it('reads nothing past its size cap as markup', () => {
    const html = chatMarkdownToHtml('x'.repeat(20_000) + '**late**');
    expect(html).toContain('**late**');
  });
});

describe('chat Markdown: formatting', () => {
  it('reads emphasis, strike-through, code and nesting', () => {
    expect(chatMarkdownToHtml('**bold** and *italic* and _under_ and ~~gone~~ and `code`')).toBe(
      '<p><strong>bold</strong> and <em>italic</em> and <em>under</em> and <del>gone</del> and <code>code</code></p>',
    );
    expect(chatMarkdownToHtml('**bold *and italic***')).toBe(
      '<p><strong>bold <em>and italic</em></strong></p>',
    );
    expect(chatMarkdownToHtml('`**not bold**`')).toBe('<p><code>**not bold**</code></p>');
  });

  it('leaves snake_case, lone stars and unmatched markers alone', () => {
    expect(chatMarkdownToHtml('a snake_case_name and 2 * 3 * 4 and **open')).toBe(
      '<p>a snake_case_name and 2 * 3 * 4 and **open</p>',
    );
  });

  it('lets a backslash escape a marker', () => {
    expect(chatMarkdownToHtml('\\*not italic\\* and \\`not code\\`')).toBe(
      '<p>*not italic* and `not code`</p>',
    );
  });

  it('links bare addresses without taking the punctuation after them', () => {
    expect(chatMarkdownToHtml('see https://example.com/a?b=1, then')).toContain(
      '<a href="https://example.com/a?b=1"',
    );
    expect(hrefs(parseChatMarkdown('(https://example.com).'))).toEqual(['https://example.com']);
    expect(hrefs(parseChatMarkdown('ftp://example.com and javascript:alert(1)'))).toEqual([]);
  });

  it('reads fenced code with a language, quotes, lists, headings and rules', () => {
    expect(chatMarkdownToHtml('```ts\nconst a = 1 < 2;\n```')).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
    );
    expect(chatMarkdownToHtml('> one\n> two')).toBe('<blockquote><p>one<br>two</p></blockquote>');
    expect(chatMarkdownToHtml('- a\n- b **x**')).toBe(
      '<ul><li><p>a</p></li><li><p>b <strong>x</strong></p></li></ul>',
    );
    expect(chatMarkdownToHtml('3. c\n4. d')).toBe(
      '<ol start="3"><li><p>c</p></li><li><p>d</p></li></ol>',
    );
    expect(chatMarkdownToHtml('# Title\n---\ntext')).toBe('<h1>Title</h1><hr><p>text</p>');
  });

  it('keeps line breaks inside a paragraph and starts a new one at a blank line', () => {
    expect(chatMarkdownToHtml('one\ntwo\n\nthree')).toBe('<p>one<br>two</p><p>three</p>');
  });

  it('makes a plain-text preview', () => {
    expect(chatMarkdownToText('**Hi** [there](https://x.example)\n> quoted `code`')).toBe(
      'Hi there quoted code',
    );
  });

  it('parses inline text directly too', () => {
    expect(parseInline('a *b* c')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'em', c: [{ t: 'text', v: 'b' }] },
      { t: 'text', v: ' c' },
    ]);
  });
});
