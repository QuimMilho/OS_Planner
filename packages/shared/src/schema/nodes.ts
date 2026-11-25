import { Node, mergeAttributes } from '@tiptap/core';
import {
  CALLOUT_VARIANTS,
  DEFAULT_CHART_DATA,
  DEFAULT_PLOT_SPEC,
  type CalloutVariant,
  type ChartData,
  type ChartOptions,
  type ChartType,
  type ImageAlign,
  type PlotSpec,
} from './specs';

export type MediaPathResolver = (id: string, kind: 'media' | 'poster') => string;

const defaultMediaPath: MediaPathResolver = (id) => `media/${id}`;

function jsonAttr<T>(el: Element, name: string, fallback: T): T {
  try {
    const raw = el.getAttribute(name);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Fence delimiter long enough that the content can never close it early. */
function fence(content: string): string {
  const longest = Math.max(0, ...(content.match(/`{3,}/g) ?? []).map((m) => m.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function fenced(lang: string, content: string): string {
  const f = fence(content);
  return `${f}${lang}\n${content}\n${f}`;
}

// ---------------------------------------------------------------- image

export interface ImageFigureOptions {
  mediaPath: MediaPathResolver;
}

export const ImageFigure = Node.create<ImageFigureOptions>({
  name: 'imageFigure',
  group: 'block',
  atom: true,
  draggable: true,

  addOptions() {
    return { mediaPath: defaultMediaPath };
  },

  addAttributes() {
    return {
      mediaId: { default: null as string | null, rendered: false },
      alt: { default: '', rendered: false },
      caption: { default: '', rendered: false },
      /** Percentage of the content width, or null for the natural size. */
      width: { default: null as number | null, rendered: false },
      align: { default: 'center' as ImageAlign, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-type="image-figure"]',
        getAttrs: (el) => {
          const fig = el as HTMLElement;
          const img = fig.querySelector('img');
          const width = Number(fig.getAttribute('data-width'));
          return {
            mediaId: fig.getAttribute('data-media-id'),
            alt: img?.getAttribute('alt') ?? '',
            caption: fig.querySelector('figcaption')?.textContent ?? '',
            width: Number.isFinite(width) && width > 0 ? width : null,
            align: fig.getAttribute('data-align') ?? 'center',
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const { mediaId, alt, caption, width, align } = node.attrs;
    const attrs: Record<string, string> = {
      'data-type': 'image-figure',
      'data-align': align,
    };
    if (mediaId) attrs['data-media-id'] = mediaId;
    if (width) {
      attrs['data-width'] = String(width);
      attrs['style'] = `width: ${Number(width)}%`;
    }
    const img: [string, Record<string, string>] = ['img', { alt: alt ?? '', 'data-media-id': mediaId ?? '' }];
    return caption
      ? ['figure', attrs, img, ['figcaption', {}, caption]]
      : ['figure', attrs, img];
  },

  markdownTokenName: 'image',

  /** `![alt](media/<uuid>.ext "caption")` re-imports as a figure; remote images degrade to a link. */
  parseMarkdown(token, helpers) {
    const href = String(token['href'] ?? '');
    const alt = String(token['text'] ?? '');
    const id = /(?:^|\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.\w+)?$/i.exec(href)?.[1];
    if (id && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      return helpers.createNode('imageFigure', {
        mediaId: id.toLowerCase(),
        alt,
        caption: String(token['title'] ?? ''),
      });
    }
    const label = alt || href;
    return helpers.createTextNode(
      label,
      /^https?:\/\//i.test(href) ? [{ type: 'link', attrs: { href } }] : [],
    );
  },

  renderMarkdown(node) {
    const { mediaId, alt, caption } = node.attrs ?? {};
    if (!mediaId) return '';
    const title = caption ? ` "${String(caption).replace(/"/g, '\\"')}"` : '';
    return `![${String(alt ?? '').replace(/[\[\]]/g, '')}](${this.options.mediaPath(mediaId, 'media')}${title})`;
  },
});

// ---------------------------------------------------------------- video

export interface VideoOptions {
  mediaPath: MediaPathResolver;
}

export const VideoNode = Node.create<VideoOptions>({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,

  addOptions() {
    return { mediaPath: defaultMediaPath };
  },

  addAttributes() {
    return {
      mediaId: { default: null as string | null, rendered: false },
      posterId: { default: null as string | null, rendered: false },
      caption: { default: '', rendered: false },
      width: { default: null as number | null, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'figure[data-type="video"]',
        getAttrs: (el) => {
          const fig = el as HTMLElement;
          const width = Number(fig.getAttribute('data-width'));
          return {
            mediaId: fig.getAttribute('data-media-id'),
            posterId: fig.getAttribute('data-poster-id'),
            caption: fig.querySelector('figcaption')?.textContent ?? '',
            width: Number.isFinite(width) && width > 0 ? width : null,
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const { mediaId, posterId, caption, width } = node.attrs;
    const attrs: Record<string, string> = { 'data-type': 'video' };
    if (mediaId) attrs['data-media-id'] = mediaId;
    if (posterId) attrs['data-poster-id'] = posterId;
    if (width) {
      attrs['data-width'] = String(width);
      attrs['style'] = `width: ${Number(width)}%`;
    }
    const video: [string, Record<string, string>] = [
      'video',
      { controls: 'controls', preload: 'metadata', 'data-media-id': mediaId ?? '', ...(posterId ? { 'data-poster-id': posterId } : {}) },
    ];
    return caption
      ? ['figure', attrs, video, ['figcaption', {}, caption]]
      : ['figure', attrs, video];
  },

  renderMarkdown(node) {
    const { mediaId, posterId, caption } = node.attrs ?? {};
    if (!mediaId) return '';
    const poster = posterId ? ` poster="${this.options.mediaPath(posterId, 'poster')}"` : '';
    const html = `<video src="${this.options.mediaPath(mediaId, 'media')}"${poster} controls></video>`;
    return caption ? `${html}\n\n*${String(caption).replace(/\n/g, ' ')}*` : html;
  },
});

// ---------------------------------------------------------------- callout

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      variant: { default: 'info' as CalloutVariant, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="callout"]',
        getAttrs: (el) => {
          const v = (el as HTMLElement).getAttribute('data-variant') as CalloutVariant;
          return { variant: CALLOUT_VARIANTS.includes(v) ? v : 'info' };
        },
      },
    ];
  },

  renderHTML({ node }) {
    return ['div', { 'data-type': 'callout', 'data-variant': node.attrs.variant, class: 'callout' }, 0];
  },

  renderMarkdown(node, h) {
    const alert = { info: 'NOTE', tip: 'TIP', warning: 'WARNING', danger: 'CAUTION' }[
      node.attrs?.variant as CalloutVariant
    ] ?? 'NOTE';
    const body = h.renderChildren(node.content ?? [], '\n\n');
    return [`> [!${alert}]`, ...body.split('\n').map((l) => (l ? `> ${l}` : '>'))].join('\n');
  },
});

// ---------------------------------------------------------------- mermaid

export const MermaidNode = Node.create({
  name: 'mermaid',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      code: { default: 'graph TD\n  A[Start] --> B[End]', rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="mermaid"]',
        getAttrs: (el) => ({ code: (el as HTMLElement).textContent ?? '' }),
      },
    ];
  },

  renderHTML({ node }) {
    return ['div', { 'data-type': 'mermaid', class: 'mermaid-block' }, String(node.attrs.code ?? '')];
  },

  renderMarkdown(node) {
    return fenced('mermaid', String(node.attrs?.code ?? ''));
  },
});

// ---------------------------------------------------------------- chart

export const ChartNode = Node.create({
  name: 'chart',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      type: { default: 'bar' as ChartType, rendered: false },
      data: { default: DEFAULT_CHART_DATA as ChartData, rendered: false },
      options: { default: {} as ChartOptions, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="chart"]',
        getAttrs: (el) => {
          const spec = jsonAttr<{ type?: ChartType; data?: ChartData; options?: ChartOptions }>(
            el as HTMLElement,
            'data-chart',
            {},
          );
          return {
            type: spec.type ?? 'bar',
            data: spec.data ?? DEFAULT_CHART_DATA,
            options: spec.options ?? {},
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const { type, data, options } = node.attrs;
    return [
      'div',
      mergeAttributes({
        'data-type': 'chart',
        class: 'chart-block',
        'data-chart': JSON.stringify({ type, data, options }),
      }),
    ];
  },

  renderMarkdown(node) {
    const { type, data, options } = node.attrs ?? {};
    return fenced('chart', JSON.stringify({ type, data, options }, null, 2));
  },
});

// ---------------------------------------------------------------- function plot

export const FunctionPlotNode = Node.create({
  name: 'functionPlot',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      expressions: { default: DEFAULT_PLOT_SPEC.expressions as PlotSpec['expressions'], rendered: false },
      xDomain: { default: DEFAULT_PLOT_SPEC.xDomain as PlotSpec['xDomain'], rendered: false },
      yDomain: { default: DEFAULT_PLOT_SPEC.yDomain as PlotSpec['yDomain'], rendered: false },
      grid: { default: DEFAULT_PLOT_SPEC.grid, rendered: false },
      title: { default: '' as string, rendered: false },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="function-plot"]',
        getAttrs: (el) => {
          const spec = jsonAttr<Partial<PlotSpec>>(el as HTMLElement, 'data-plot', {});
          return {
            expressions: spec.expressions ?? DEFAULT_PLOT_SPEC.expressions,
            xDomain: spec.xDomain ?? DEFAULT_PLOT_SPEC.xDomain,
            yDomain: spec.yDomain ?? null,
            grid: spec.grid ?? true,
            title: spec.title ?? '',
          };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const { expressions, xDomain, yDomain, grid, title } = node.attrs;
    return [
      'div',
      {
        'data-type': 'function-plot',
        class: 'plot-block',
        'data-plot': JSON.stringify({ expressions, xDomain, yDomain, grid, title }),
      },
    ];
  },

  renderMarkdown(node) {
    const { expressions, xDomain, yDomain, grid, title } = node.attrs ?? {};
    return fenced('plot', JSON.stringify({ expressions, xDomain, yDomain, grid, title }, null, 2));
  },
});
