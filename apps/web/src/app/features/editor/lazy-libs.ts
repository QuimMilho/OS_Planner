import type { PlannerLibs } from '@os-planner/shared';

/**
 * Mermaid, Chart.js, function-plot and KaTeX's renderer are large, so they live in one standalone
 * script (`/print/planner-libs.js`, built from @os-planner/shared with plain esbuild) that is fetched the
 * first time a page actually contains a diagram, chart or plot. The PDF renderer loads the very same
 * file, so a diagram looks identical on screen and on paper. The service worker caches it, so after
 * the first use it works offline too.
 */
let loading: Promise<PlannerLibs> | null = null;

export function loadLibs(): Promise<PlannerLibs> {
  return (loading ??= new Promise<PlannerLibs>((resolve, reject) => {
    if (window.PlannerLibs) return resolve(window.PlannerLibs);
    const script = document.createElement('script');
    script.src = '/print/planner-libs.js';
    script.async = true;
    script.onload = () => (window.PlannerLibs ? resolve(window.PlannerLibs) : reject(new Error('The drawing libraries did not initialise.')));
    script.onerror = () => {
      loading = null; // offline the first time: allow a retry once the connection is back
      script.remove();
      reject(new Error('The drawing libraries could not be loaded. Check your connection.'));
    };
    document.head.appendChild(script);
  }));
}

/** Whether the page is dark right now. Every theme sets `color-scheme`; only "same as device" leaves it to the OS. */
export const isDark = (): boolean => {
  const scheme = getComputedStyle(document.documentElement).colorScheme;
  if (scheme === 'dark') return true;
  if (scheme === 'light') return false;
  return matchMedia('(prefers-color-scheme: dark)').matches;
};

export async function renderMermaid(id: string, code: string): Promise<string> {
  return (await loadLibs()).mermaid(id, code, isDark());
}

/** KaTeX is already part of the editor (the math extension needs it), so it is imported normally. */
let katexPromise: Promise<typeof import('katex').default> | null = null;
export function loadKatex() {
  return (katexPromise ??= import('katex').then((m) => m.default));
}
