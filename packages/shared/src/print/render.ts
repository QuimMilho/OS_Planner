import type { JSONContent } from '@tiptap/core';
import { generateHTML } from '@tiptap/html';
import type { Locale } from '../dto/common';
import { getSchemaExtensions } from '../schema';
import { formatPrintDate, PRINT_LABELS } from './labels';
import { printCss, type PrintPageSize } from './styles';

export type PrintEntry =
  | { kind: 'category'; id: string; name: string; depth: number }
  | { kind: 'page'; id: string; title: string; doc: JSONContent; depth: number };

export interface PrintInput {
  /** Document title: shown on the cover and used as the HTML <title>. */
  title: string;
  /** Line under the title on the cover, e.g. "Notebook". */
  subtitle?: string;
  /** Pages and category dividers in reading order. */
  entries: PrintEntry[];
  locale: Locale;
  pageSize: PrintPageSize;
  /** Cover page. Off for a single-page export. */
  cover: boolean;
  includeToc: boolean;
  generatedAt?: Date;
  /** Where the print page can load an uploaded image/video poster from. */
  mediaUrl: (mediaId: string) => string;
  /**
   * Base URL of the print assets (`print-runtime.js`, `katex/katex.min.css`), ending in "/".
   * Omit to produce static HTML with no script (used by tests and for plain-text previews).
   */
  assetsBase?: string;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Turns the editor's media references into URLs the print page can load, and swaps media that cannot print. */
function resolveMedia(html: string, mediaUrl: (id: string) => string, videoLabel: string): string {
  // <video> cannot play on paper: show its poster frame with a play badge, or a placeholder.
  html = html.replace(/<video\b([^>]*?)>\s*<\/video>/gi, (_m, attrs: string) => {
    const poster = new RegExp(`data-poster-id="(${UUID})"`, 'i').exec(attrs)?.[1];
    return poster
      ? `<span class="video-box"><img src="${esc(mediaUrl(poster))}" alt="${esc(videoLabel)}"><span class="play">▶</span></span>`
      : `<span class="video-placeholder">▶ ${esc(videoLabel)}</span>`;
  });
  return html.replace(
    new RegExp(`<img\\b([^>]*?)data-media-id="(${UUID})"([^>]*)>`, 'gi'),
    (_m, before: string, id: string, after: string) => `<img ${before}data-media-id="${id}" src="${esc(mediaUrl(id))}"${after}>`,
  );
}

/** YouTube iframes cannot load in a PDF: print the link instead. */
function replaceEmbeds(html: string): string {
  return html.replace(
    /<div data-youtube-video[^>]*>\s*<iframe[^>]*?\ssrc="([^"]+)"[^>]*>\s*<\/iframe>\s*<\/div>/gi,
    (_m, src: string) => `<p class="embed-link">▶ <a href="${src}">${src}</a></p>`,
  );
}

/** The page title is the document's H1, so headings written inside the page move down one level. */
const demoteHeadings = (html: string): string =>
  html.replace(/<(\/?)h([1-6])\b/g, (_m, slash: string, n: string) => `<${slash}h${Math.min(6, Number(n) + 1)}`);

/** Content that cannot be rendered on the server is left as placeholders for the print runtime. */
export function renderDocBody(doc: JSONContent, mediaUrl: (id: string) => string, videoLabel = 'Video'): string {
  const html = generateHTML(doc, getSchemaExtensions());
  return resolveMedia(replaceEmbeds(demoteHeadings(html)), mediaUrl, videoLabel);
}

/**
 * Builds the complete printable HTML for a page, category or notebook. The output is a plain
 * document: a headless Chromium (server) or the user's own browser (offline fallback) turns
 * it into a PDF. Diagrams, charts, plots and math are drawn by the print runtime script.
 */
export function renderPrintHtml(input: PrintInput): string {
  const L = PRINT_LABELS[input.locale];
  const date = formatPrintDate(input.generatedAt ?? new Date(), input.locale);

  const cover = input.cover
    ? `<header class="cover"><h1>${esc(input.title)}</h1>${
        input.subtitle ? `<p class="subtitle">${esc(input.subtitle)}</p>` : ''
      }<p class="date">${esc(L.generated(date))}</p></header>`
    : '';

  const toc =
    input.includeToc && input.entries.length
      ? `<nav class="toc"><h2>${esc(L.toc)}</h2><ol>${input.entries
          .map((e) =>
            e.kind === 'category'
              ? `<li class="toc-category d${e.depth}"><a href="#c-${esc(e.id)}">${esc(e.name || L.untitled)}</a></li>`
              : `<li class="d${e.depth}"><a href="#p-${esc(e.id)}">${esc(e.title || L.untitled)}</a></li>`,
          )
          .join('')}</ol></nav>`
      : '';

  const body = input.entries
    .map((e) =>
      e.kind === 'category'
        ? `<h1 class="category-title" id="c-${esc(e.id)}">${esc(e.name || L.untitled)}</h1>`
        : `<section class="page" id="p-${esc(e.id)}"><h1 class="page-title">${esc(e.title || L.untitled)}</h1>${renderDocBody(
            e.doc,
            input.mediaUrl,
            L.video,
          )}</section>`,
    )
    .join('\n');

  const assets = input.assetsBase
    ? {
        css: `<link rel="stylesheet" href="${esc(input.assetsBase)}katex/katex.min.css">`,
        js: `<script src="${esc(input.assetsBase)}notes-libs.js"></script>\n<script src="${esc(input.assetsBase)}print-runtime.js"></script>`,
      }
    : { css: '', js: '' };

  return `<!doctype html>
<html lang="${input.locale}">
<head>
<meta charset="utf-8">
<title>${esc(input.title)}</title>
${assets.css}
<style>${printCss(input.pageSize)}</style>
</head>
<body class="print">
${cover}
${toc}
${body}
${assets.js}
</body>
</html>`;
}
