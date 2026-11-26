import { defineConfig } from 'tsup';

export default defineConfig([
  // The library: consumed by the server (ESM/CJS) and by the Angular app.
  // Dependencies stay external: each consumer resolves them itself.
  {
    // `lite` is a second entry on purpose: the full package builds TipTap nodes and zod schemas at import
    // time, which a bundler cannot drop, so code on the first-load path imports `@os-planner/shared/lite`
    // (a handful of helpers) and the heavy libraries only load with the screens that need them.
    entry: { index: 'src/index.ts', lite: 'src/lite.ts', chat: 'src/chat.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    target: 'es2022',
    splitting: true,
  },
  // Two self-contained browser scripts (the print page has no network access):
  //   planner-libs.js    every drawing library (Mermaid, Chart.js, function-plot, KaTeX, highlight.js)
  //   print-runtime.js small; draws a printable document's placeholders using PlannerLibs
  {
    entry: { 'planner-libs': 'src/print/libs.ts', 'print-runtime': 'src/print/runtime.ts' },
    outDir: 'dist/print',
    format: ['iife'],
    platform: 'browser',
    target: 'es2020',
    minify: true,
    splitting: false,
    sourcemap: false,
    dts: false,
    noExternal: [/.*/],
    define: { 'process.env.NODE_ENV': '"production"' },
    esbuildOptions(options) {
      options.legalComments = 'none';
    },
  },
]);
