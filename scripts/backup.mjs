#!/usr/bin/env node
// Backs up an OS_Planner instance: the database (a consistent mysqldump) and DATA_DIR (uploaded files, desktop releases).
//
//   node scripts/backup.mjs                      into ./backups/<time>/, mysqldump run inside the compose service "mysql"
//   node scripts/backup.mjs --out=/srv/backups   another folder
//   node scripts/backup.mjs --no-docker          mysqldump from the PATH (a MySQL that is not the compose one)
//
// DATABASE_URL and DATA_DIR come from the environment, else from the repository's .env. Restore with scripts/restore.mjs.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  dumpDatabase,
  inventory,
  lastMigration,
  packData,
  parseDatabaseUrl,
  stamp,
  writeManifest,
} from './lib/backup.mjs';

const root = resolve(import.meta.dirname, '..');
const arg = (name) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const databaseUrl = arg('database-url') ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is not set');
const db = parseDatabaseUrl(databaseUrl);
const dataDir = resolve(root, 'apps/server', arg('data-dir') ?? process.env.DATA_DIR ?? './data');
const docker = process.argv.includes('--no-docker') ? null : (arg('docker-service') ?? 'mysql');
const out = resolve(arg('out') ?? resolve(root, 'backups'), stamp());
mkdirSync(out, { recursive: true });

console.log(`database ${db.database} -> ${out}/database.sql.gz`);
await dumpDatabase(db, out, { docker });
console.log(`files ${dataDir} -> ${out}/data.tar.gz`);
packData(dataDir, out);
const files = inventory(dataDir);
writeManifest(out, {
  app: JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version,
  createdAt: new Date().toISOString(),
  database: db.database,
  migration: lastMigration(root),
  files: files.files.length,
  bytes: files.bytes,
});
console.log(
  `done: ${files.files.length} files, ${(files.bytes / 1e6).toFixed(1)} MB of data; keep the folder somewhere else than this machine`,
);
