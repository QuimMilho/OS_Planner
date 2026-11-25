// Renders the app icon (apps/web/public/favicon.svg) to the PNG sizes the PWA manifest and the
// desktop installers need. Run once after changing the SVG:  node scripts/make-icons.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(resolve(import.meta.dirname, '../apps/server/package.json'));
const sharp = require('sharp');

const svg = readFileSync(resolve(import.meta.dirname, '../apps/web/public/favicon.svg'));
const webIcons = resolve(import.meta.dirname, '../apps/web/public/icons');
const desktopBuild = resolve(import.meta.dirname, '../apps/desktop/build');
mkdirSync(webIcons, { recursive: true });
mkdirSync(desktopBuild, { recursive: true });

const render = (size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();

// "maskable" icons must keep their artwork inside the central 80% safe zone, so shrink and pad.
async function maskable(size) {
  const inner = Math.round(size * 0.72);
  const art = await sharp(svg, { density: 384 }).resize(inner, inner).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: '#3b5bdb' } })
    .composite([{ input: art, gravity: 'center' }])
    .png()
    .toBuffer();
}

writeFileSync(join(webIcons, 'icon-192.png'), await render(192));
writeFileSync(join(webIcons, 'icon-512.png'), await render(512));
writeFileSync(join(webIcons, 'icon-maskable-512.png'), await maskable(512));
writeFileSync(join(webIcons, 'apple-touch-icon.png'), await render(180));
// electron-builder wants a 512+ PNG (it derives .ico/.icns from it).
writeFileSync(join(desktopBuild, 'icon.png'), await render(1024));
console.log('icons written to', webIcons, 'and', desktopBuild);
