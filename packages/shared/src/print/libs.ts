/**
 * Entry point of `notes-libs.js` (see libs-types.ts). Bundled with plain esbuild into one
 * self-contained browser script: it has no network access and no dependencies at run time.
 * (Function plots are not here: they are drawn by shared/schema/plot.ts, which needs no library.)
 */
import { Chart, registerables } from 'chart.js';
import hljs from 'highlight.js/lib/common';
import katex from 'katex';
import mermaid from 'mermaid';
import { chartJsConfig } from '../schema/render-config';
import type { NotesLibs } from './libs-types';

Chart.register(...registerables);

/**
 * Chart.js draws its text and grid in fixed greys, which vanish on a dark page. The editor passes the page's own text and
 * grid colours; the PDF renderer passes nothing and keeps the defaults (print is always light).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withColors(type: string, options: any, { text, grid }: { text: string; grid: string }): any {
  const scales: Record<string, unknown> = {};
  for (const [id, scale] of Object.entries<Record<string, unknown>>(options.scales ?? {})) {
    scales[id] = { ...scale, grid: { color: grid }, border: { color: grid }, ticks: { color: text }, title: { ...(scale['title'] as object), color: text } };
  }
  // radar has one radial scale that the stored configuration does not mention (pie and doughnut have none)
  if (type === 'radar') scales['r'] = { grid: { color: grid }, angleLines: { color: grid }, pointLabels: { color: text }, ticks: { color: text, backdropColor: 'transparent' } };
  return {
    ...options,
    color: text,
    ...(Object.keys(scales).length ? { scales } : {}),
    plugins: { ...options.plugins, title: { ...options.plugins?.title, color: text }, legend: { ...options.plugins?.legend, labels: { color: text } } },
  };
}

const libs: NotesLibs = {
  async mermaid(id, code, dark) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', fontFamily: 'inherit' });
    try {
      const { svg } = await mermaid.render(id, code);
      return svg;
    } catch (e) {
      // On failure mermaid leaves its scratch element ("d" + id) attached to <body>.
      document.getElementById(`d${id}`)?.remove();
      throw e;
    }
  },

  chart(canvas, type, data, options, render) {
    const config = chartJsConfig(type, data, options, { animate: render.animate, devicePixelRatio: render.devicePixelRatio });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const colored = render.colors ? withColors(type, config.options, render.colors) : config.options;
    return new Chart(canvas, { ...config, options: { ...colored, responsive: render.responsive } } as any);
  },

  katex(el, latex, displayMode, throwOnError) {
    katex.render(latex, el, { displayMode, throwOnError, output: 'html' });
  },

  highlight(el) {
    const lang = /language-([\w+#.-]+)/.exec(el.className)?.[1];
    if (lang && hljs.getLanguage(lang)) hljs.highlightElement(el);
  },
};

window.NotesLibs = libs;
