// Copies the print runtime (print-runtime.js + KaTeX css/fonts) built by @os-planner/shared into the web
// app's public folder, where Angular serves it as /print/. It is used for the offline "print to PDF"
// fallback. Run automatically before `ng build` and `ng serve`.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve(import.meta.dirname, '../packages/shared/dist/print');
const target = resolve(import.meta.dirname, '../apps/web/public/print');

if (!existsSync(resolve(source, 'print-runtime.js'))) {
  console.error('packages/shared has not been built: run `npm run build -w @os-planner/shared` first.');
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log('print assets copied to apps/web/public/print');
