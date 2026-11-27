// Publishes the desktop builds to an OS_Planner server, so they appear on its /download page and installed
// apps can update themselves from /downloads/.
//
//   OS_PLANNER_API_URL=https://api.example.com RELEASE_TOKEN=... node scripts/publish-desktop.mjs
//
// The upload goes to the API (OS_PLANNER_API_URL). When the API shares the website's origin, OS_PLANNER_SERVER_URL works too.
//
// Reads the artifacts that `npm run dist:win` / `npm run dist:linux` left in apps/desktop/release,
// uploads them (streamed, so large installers are fine), then tells the server which files form the
// release. The server computes sizes and SHA-256 checksums itself.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

const root = resolve(import.meta.dirname, '..');
const releaseDir = resolve(root, 'apps/desktop/release');
const server = (process.env.OS_PLANNER_API_URL || process.env.OS_PLANNER_SERVER_URL || '').replace(/\/+$/, '');
const token = process.env.RELEASE_TOKEN;
const notes = process.env.RELEASE_NOTES ?? '';

if (!server || !token) {
  console.error("Set OS_PLANNER_API_URL (or OS_PLANNER_SERVER_URL when the API is on the website's origin) and RELEASE_TOKEN (the server must have RELEASE_TOKEN configured too).");
  process.exit(1);
}
if (!existsSync(releaseDir)) {
  console.error(`Nothing to publish: ${releaseDir} does not exist. Run "npm run dist:win" and/or "npm run dist:linux" first.`);
  process.exit(1);
}

const version = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8')).version;

/** Works out what a file is from its name (electron-builder.yml fixes the naming scheme). */
function describe(name) {
  if (new RegExp(`^OS_Planner-${version}-win-(x64|arm64)-setup\\.exe$`).test(name)) return { os: 'windows', arch: RegExp.$1, format: 'nsis' };
  if (new RegExp(`^OS_Planner-${version}-win-(x64|arm64)-portable\\.exe$`).test(name)) return { os: 'windows', arch: RegExp.$1, format: 'portable' };
  if (new RegExp(`^OS_Planner-${version}-linux-(x64|arm64)\\.AppImage$`).test(name)) return { os: 'linux', arch: RegExp.$1, format: 'appimage' };
  if (new RegExp(`^OS_Planner-${version}-linux-(x64|arm64)\\.deb$`).test(name)) return { os: 'linux', arch: RegExp.$1, format: 'deb' };
  if (new RegExp(`^OS_Planner-${version}-linux-(x64|arm64)\\.rpm$`).test(name)) return { os: 'linux', arch: RegExp.$1, format: 'rpm' };
  return null;
}

const files = readdirSync(releaseDir).filter((n) => statSync(resolve(releaseDir, n)).isFile());
const builds = files.map((name) => ({ name, info: describe(name) })).filter((f) => f.info);
// Updater metadata: electron-updater reads these (and the blockmaps) from /downloads/.
const extras = files.filter((n) => /^latest(-linux)?\.yml$/.test(n) || /\.blockmap$/.test(n));

if (!builds.length) {
  console.error(`No OS_Planner ${version} installers found in ${releaseDir}.`);
  process.exit(1);
}

const auth = { Authorization: `Bearer ${token}` };

async function upload(name) {
  const path = resolve(releaseDir, name);
  const size = statSync(path).size;
  process.stdout.write(`  uploading ${name} (${(size / 1024 / 1024).toFixed(1)} MB) … `);
  const res = await fetch(`${server}/api/admin/releases/files/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { ...auth, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body: Readable.toWeb(createReadStream(path)),
    duplex: 'half',
  });
  if (!res.ok) throw new Error(`upload of ${name} failed: ${res.status} ${await res.text()}`);
  console.log('ok');
}

console.log(`Publishing OS_Planner ${version} to ${server}`);
for (const name of [...builds.map((b) => b.name), ...extras]) await upload(name);

const res = await fetch(`${server}/api/admin/releases`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ version, notes, files: builds.map((b) => ({ name: b.name, ...b.info })) }),
});
if (!res.ok) throw new Error(`publishing the release failed: ${res.status} ${await res.text()}`);
const manifest = await res.json();
console.log(`Published. ${manifest.files.length} download(s) are now listed at ${server}/download`);
for (const f of manifest.files) console.log(`  ${f.format.padEnd(9)} ${f.name}  ${f.sha256.slice(0, 12)}…`);
