// Decides which API the website talks to and writes it to apps/web/public/config.json,
// which ends up next to index.html in the build:   { "apiUrl": "https://api.example.com" }
//
//   NOTES_API_URL=https://api.example.com npm run build -w @notes/web     (no question asked)
//   npm run build -w @notes/web                                           (asks on a terminal; blank = same origin)
//
// An empty apiUrl (the default) means the API is on the same origin as the website, i.e. /api/...
// Whoever deploys the build can edit dist/.../config.json later without rebuilding.
//
// Flags: --no-prompt  never ask (used by `npm start`; env and .env are still honoured)
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSetting, urlOrEmpty } from './lib/resolve-setting.mjs';

const out = resolve(import.meta.dirname, '../apps/web/public/config.json');

try {
  const { value, source } = await resolveSetting({
    name: 'NOTES_API_URL',
    question: 'Where is the Notes API? (address of the server, e.g. https://api.example.com)',
    validate: urlOrEmpty,
    prompt: process.argv.includes('--no-prompt') ? false : undefined,
  });
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ apiUrl: value }, null, 2)}\n`);
  console.log(`web config: API ${value || 'on the same origin as the website'} (${source})`);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
