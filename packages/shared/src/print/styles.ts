export type PrintPageSize = 'A4' | 'Letter';

/** Stylesheet for the printable document. Pure CSS, no external requests. */
export function printCss(pageSize: PrintPageSize): string {
  return `
@page { size: ${pageSize}; margin: 20mm 17mm 22mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0; color: #1d2330; background: #fff;
  /* Deliberately no "Segoe UI"/system-ui: with Segoe UI, Chrome writes every heading twice into the
     PDF outline ("BasicsBasics"). Arial (Windows/macOS) and Liberation Sans (Linux) are metric-compatible. */
  font: 11pt/1.55 Arial, "Liberation Sans", "Helvetica Neue", Helvetica, "Noto Sans", sans-serif;
  overflow-wrap: anywhere;
}

/* ---- cover + table of contents ---- */
.cover { min-height: 240mm; display: flex; flex-direction: column; justify-content: center; padding: 0 6mm; }
.cover h1 { font-size: 30pt; line-height: 1.15; margin: 0 0 6mm; letter-spacing: -0.01em; }
.cover .subtitle { font-size: 14pt; color: #5b6475; margin: 0 0 3mm; }
.cover .date { font-size: 10pt; color: #8a93a5; margin: 0; }
.toc { break-before: page; }
.toc h2 { font-size: 20pt; margin: 0 0 6mm; }
.toc ol { list-style: none; margin: 0; padding: 0; }
.toc li { margin: 1.6mm 0; }
.toc a { color: inherit; text-decoration: none; }
.toc .toc-category { font-weight: 600; margin-top: 4mm; }
.toc .d1 { margin-left: 6mm; } .toc .d2 { margin-left: 12mm; } .toc .d3 { margin-left: 18mm; }
.toc .d4 { margin-left: 24mm; } .toc .d5 { margin-left: 30mm; } .toc .d6, .toc .d7, .toc .d8 { margin-left: 36mm; }

/* ---- structure ---- */
.category-title { break-before: page; font-size: 24pt; margin: 0 0 8mm; padding-bottom: 3mm; border-bottom: 2px solid #3b5bdb; }
section.page { break-before: page; }
section.page:first-child { break-before: auto; }
.page-title { font-size: 22pt; line-height: 1.2; margin: 0 0 6mm; }
.cover + .toc + section.page, .cover + section.page { break-before: page; }

/* ---- text ---- */
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.3em 0 0.5em; break-after: avoid; }
h2 { font-size: 17pt; } h3 { font-size: 14pt; } h4 { font-size: 12pt; } h5, h6 { font-size: 11pt; }
p { margin: 0 0 0.7em; orphans: 3; widows: 3; }
a { color: #3b5bdb; text-decoration: underline; }
mark { padding: 0 0.15em; border-radius: 2px; }
sub, sup { line-height: 0; }
hr { border: 0; border-top: 1px solid #d5d9e2; margin: 1.4em 0; }
ul, ol { margin: 0 0 0.8em; padding-left: 1.5em; }
li > p { margin-bottom: 0.2em; }
blockquote { margin: 0 0 0.9em; padding: 0.2em 1em; border-left: 3px solid #c3c9d6; color: #4a5365; }

/* ---- code ---- */
code { font: 0.9em "Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace; background: #f1f3f8; padding: 0.1em 0.3em; border-radius: 3px; }
pre { margin: 0 0 1em; padding: 3mm 4mm; background: #f6f7fb; border: 1px solid #e1e5ee; border-radius: 4px; white-space: pre-wrap; break-inside: avoid; }
pre code { background: none; padding: 0; font-size: 9.5pt; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-built_in { color: #a626a4; }
.hljs-string, .hljs-attr, .hljs-template-variable { color: #50a14f; }
.hljs-number, .hljs-symbol, .hljs-bullet { color: #986801; }
.hljs-comment, .hljs-quote { color: #8a93a5; font-style: italic; }
.hljs-title, .hljs-function .hljs-title, .hljs-section { color: #4078f2; }
.hljs-type, .hljs-class .hljs-title { color: #c18401; }

/* ---- tables ---- */
table { border-collapse: collapse; width: 100%; margin: 0 0 1em; break-inside: auto; }
tr { break-inside: avoid; }
th, td { border: 1px solid #cdd3df; padding: 1.6mm 2.6mm; vertical-align: top; text-align: left; }
th { background: #eef1f8; font-weight: 600; }
td p, th p { margin: 0; }

/* ---- task lists, details ---- */
ul[data-type="taskList"] { list-style: none; padding-left: 0.3em; }
ul[data-type="taskList"] li > label { margin-right: 0.5em; }
ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 0.4em; }
ul[data-type="taskList"] li > div { flex: 1; }
details { margin: 0 0 1em; padding: 2mm 4mm; border: 1px solid #e1e5ee; border-radius: 4px; }
details > summary { font-weight: 600; cursor: default; list-style: none; }
details > summary::before { content: "▾ "; }

/* ---- figures ---- */
figure { margin: 0 0 1em; break-inside: avoid; text-align: center; }
figure img, figure video { max-width: 100%; height: auto; }
figure[data-align="left"] { text-align: left; } figure[data-align="right"] { text-align: right; }
figure[data-width] { margin-left: auto; margin-right: auto; }
figure[data-align="left"][data-width] { margin-left: 0; } figure[data-align="right"][data-width] { margin-right: 0; }
figcaption { font-size: 9.5pt; color: #5b6475; margin-top: 1.5mm; }
.video-box { position: relative; display: inline-block; max-width: 100%; }
.video-box .play { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 28pt; color: #fff; text-shadow: 0 1px 6px rgba(0,0,0,.6); }
.video-placeholder { display: inline-block; padding: 8mm 16mm; background: #eef1f8; border: 1px dashed #aab2c5; border-radius: 4px; color: #5b6475; }
.embed-link { padding: 2.5mm 4mm; background: #f6f7fb; border: 1px solid #e1e5ee; border-radius: 4px; word-break: break-all; }

/* ---- callouts ---- */
.callout { margin: 0 0 1em; padding: 2.5mm 4mm; border-left: 4px solid #3b5bdb; background: #edf2ff; border-radius: 3px; break-inside: avoid; }
.callout > :last-child { margin-bottom: 0; }
.callout[data-variant="tip"] { border-color: #2f9e44; background: #ebfbee; }
.callout[data-variant="warning"] { border-color: #f08c00; background: #fff4e6; }
.callout[data-variant="danger"] { border-color: #e03131; background: #fff5f5; }

/* ---- math, diagrams, charts ---- */
[data-type="block-math"] { margin: 0.8em 0; text-align: center; overflow-x: auto; break-inside: avoid; }
.mermaid-block, .chart-block, .plot-block { margin: 0 0 1em; text-align: center; break-inside: avoid; }
.mermaid-block svg, .plot-block svg { max-width: 100%; height: auto; }
.chart-block canvas { max-width: 100%; }
.diagram-error { color: #c92a2a; background: #fff5f5; border: 1px solid #ffc9c9; padding: 2mm 3mm; font-size: 9pt; text-align: left; white-space: pre-wrap; }
`;
}
