import type { JSONContent } from '@tiptap/core';

export const IMG_ID = '0192f0a4-7c1e-7b3a-9d2e-3f4a5b6c7d8e';
export const VID_ID = '0192f0a4-7c1e-7b3a-9d2e-3f4a5b6c7d8f';

/** A document exercising every node and the important marks. Used by tests and by seed scripts. */
export function richDoc(): JSONContent {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Física 101' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Some ' },
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' and a ' },
          { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
          { type: 'text', text: ' with ' },
          { type: 'inlineMath', attrs: { latex: 'E=mc^2' } },
        ],
      },
      { type: 'blockMath', attrs: { latex: '\\int_0^1 x^2\\,dx = \\tfrac13' } },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
        ],
      },
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: true },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'done' }] }],
          },
        ],
      },
      {
        type: 'codeBlock',
        attrs: { language: 'typescript' },
        content: [{ type: 'text', text: 'const x: number = 1;' }],
      },
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
              { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1' }] }] },
              { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '2' }] }] },
            ],
          },
        ],
      },
      {
        type: 'callout',
        attrs: { variant: 'warning' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Careful here' }] }],
      },
      { type: 'mermaid', attrs: { code: 'graph TD\n  A-->B' } },
      {
        type: 'chart',
        attrs: {
          type: 'bar',
          data: { labels: ['Jan', 'Fev'], datasets: [{ label: 'Vendas', data: [3, 5] }] },
          options: { title: 'Resultados' },
        },
      },
      {
        type: 'functionPlot',
        attrs: {
          expressions: [{ kind: 'linear', fn: 'sin(x)/x' }],
          xDomain: [-10, 10],
          yDomain: null,
          grid: true,
          title: 'Sinc',
        },
      },
      { type: 'imageFigure', attrs: { mediaId: IMG_ID, alt: 'Diagram', caption: 'Figure 1', width: 60, align: 'center' } },
      { type: 'video', attrs: { mediaId: VID_ID, posterId: null, caption: 'Demo', width: 80 } },
    ],
  };
}
