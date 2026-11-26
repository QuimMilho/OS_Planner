// Runs around tsup: clears dist beforehand (tsup's own clean would race its two parallel builds)
// and copies KaTeX's stylesheet and fonts next to the print runtime afterwards.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const phase = process.argv[2];

if (phase === 'clean') {
  rmSync(join(root, 'dist'), { recursive: true, force: true });
} else if (phase === 'assets') {
  // tsup names IIFE output "*.global.js"; the pages ask for plain "planner-libs.js" / "print-runtime.js".
  for (const name of ['planner-libs', 'print-runtime']) {
    cpSync(join(root, 'dist', 'print', `${name}.global.js`), join(root, 'dist', 'print', `${name}.js`));
    rmSync(join(root, 'dist', 'print', `${name}.global.js`));
  }
  const katexDist = dirname(createRequire(import.meta.url).resolve('katex/package.json')) + '/dist';
  const out = join(root, 'dist', 'print', 'katex');
  mkdirSync(out, { recursive: true });
  cpSync(join(katexDist, 'katex.min.css'), join(out, 'katex.min.css'));
  // woff2 first in the CSS; only ship what a modern Chromium will actually request.
  cpSync(join(katexDist, 'fonts'), join(out, 'fonts'), { recursive: true, filter: (src) => !existsSync(src) || !/\.(ttf|woff)$/.test(src) });
  console.log('print assets copied to', out);
} else {
  throw new Error(`unknown phase "${phase}"`);
}
