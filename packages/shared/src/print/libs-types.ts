import type { ChartData, ChartOptions, ChartType } from '../schema/specs';

/**
 * The drawing libraries (Mermaid, Chart.js, KaTeX, highlight.js), bundled once as
 * `notes-libs.js` and exposed as `window.NotesLibs`. The PDF renderer and the web editor both load
 * that one script, so a diagram looks the same on screen and on paper, and the app's own bundle
 * stays small. (Angular's bundler also mis-bundled d3, which Mermaid and function-plot depend on.)
 */
export interface NotesLibs {
  /** Returns the diagram as an SVG string. Rejects with Mermaid's own message if the code is invalid. */
  mermaid(id: string, code: string, dark: boolean): Promise<string>;
  /** Draws a chart. Call `destroy()` before drawing again on the same canvas. */
  chart(
    canvas: HTMLCanvasElement,
    type: ChartType,
    data: ChartData,
    options: ChartOptions,
    render: { animate: boolean; responsive: boolean; devicePixelRatio?: number; colors?: { text: string; grid: string } },
  ): { destroy(): void };
  katex(el: HTMLElement, latex: string, displayMode: boolean, throwOnError: boolean): void;
  /** Syntax-highlights a <code class="language-x"> element in place. */
  highlight(el: HTMLElement): void;
}

declare global {
  interface Window {
    NotesLibs?: NotesLibs;
  }
}
