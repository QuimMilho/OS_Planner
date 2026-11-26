// Runs after tsc: bakes the website address into this build and copies the icon the window uses.
//
// OS_PLANNER_SERVER_URL is the website the window opens (it tells the app where its API is, through the site's config.json).
// It is taken from the environment, then the repo .env, then asked on an interactive terminal (default http://localhost:3000).
// People can still change the address from File > Change server.
import { copyFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { normaliseUrl, resolveSetting } from '../../../scripts/lib/resolve-setting.mjs';

const root = resolve(import.meta.dirname, '..');

let serverUrl;
try {
  ({ value: serverUrl } = await resolveSetting({
    name: 'OS_PLANNER_SERVER_URL',
    question: 'Which OS_Planner website should the desktop app open? (e.g. https://planner.example.com)',
    validate: normaliseUrl,
    defaultValue: 'http://localhost:3000',
  }));
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

mkdirSync(resolve(root, 'dist'), { recursive: true });
writeFileSync(resolve(root, 'dist/default-server.json'), JSON.stringify({ serverUrl }, null, 2));

mkdirSync(resolve(root, 'resources'), { recursive: true });
const icon = resolve(root, 'build/icon.png');
if (existsSync(icon)) copyFileSync(icon, resolve(root, 'resources/icon.png'));
console.log(`desktop build prepared (website: ${serverUrl})`);
