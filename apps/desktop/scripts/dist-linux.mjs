// Builds the Linux packages (AppImage, .deb, .rpm). They cannot be produced on Windows directly, so this runs
// electron-builder inside Docker (needs Docker running). On a Linux machine or in CI you can simply run
// `npx electron-builder --linux --x64 --config electron-builder.yml` after `npm run build`.
//
// The container gets a clean copy of the app, not the repo: the repo's node_modules hold Windows binaries.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const stage = resolve(root, '.linux-build');
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...options });

console.log('> compiling the app');
run('npm', ['run', 'build']);

console.log('> preparing a clean build folder');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const item of ['package.json', 'electron-builder.yml', 'dist', 'resources', 'build']) {
  if (existsSync(resolve(root, item))) cpSync(resolve(root, item), resolve(stage, item), { recursive: true });
}

console.log('> building in Docker (the first run downloads the builder image and Electron)');
run('docker', [
  'run', '--rm',
  '-v', `${stage}:/project`,
  '-w', '/project',
  '-e', 'ELECTRON_CACHE=/tmp/electron-cache',
  'electronuserland/builder:latest',
  '/bin/bash', '-c',
  'npm install --omit=dev --ignore-scripts --no-audit --no-fund && npx --yes electron-builder@26.18.0 --linux --x64 --config electron-builder.yml',
]);

const out = resolve(root, 'release');
mkdirSync(out, { recursive: true });
for (const name of readdirSync(resolve(stage, 'release'))) {
  if (/\.(AppImage|deb|rpm|yml|blockmap)$/.test(name)) cpSync(resolve(stage, 'release', name), resolve(out, name));
}
rmSync(stage, { recursive: true, force: true });
console.log('> Linux packages are in', out);
