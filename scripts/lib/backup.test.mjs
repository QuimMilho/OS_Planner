import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { client, inventory, packData, parseDatabaseUrl, stamp, unpackData } from './backup.mjs';

test('reads the database address, password and all', () => {
  assert.deepEqual(parseDatabaseUrl('mysql://notes:p%40ss@db.example.com:3307/planner'), {
    user: 'notes',
    password: 'p@ss',
    host: 'db.example.com',
    port: 3307,
    database: 'planner',
  });
  assert.throws(() => parseDatabaseUrl('postgres://x@y/z'), /mysql:\/\//);
});

test('runs the MySQL tools inside the compose service, or from the PATH', () => {
  const db = parseDatabaseUrl('mysql://notes:notes@localhost:3306/notes');
  assert.deepEqual(client('mysqldump', db, { docker: 'mysql' }), {
    cmd: 'docker',
    args: ['compose', 'exec', '-T', 'mysql', 'mysqldump', '-unotes', '-pnotes'],
  });
  assert.equal(client('mysql', db, { docker: null }).cmd, 'mysql');
});

test('a folder name sorts by time', () => {
  assert.equal(stamp(new Date('2026-11-27T17:15:00.123Z')), '2026-11-27T171500Z');
});

test('the files of DATA_DIR survive a pack and unpack, uploads in progress are left out', () => {
  const base = mkdtempSync(join(tmpdir(), 'osp-backup-'));
  try {
    const data = join(base, 'data');
    mkdirSync(join(data, 'media', 'u1'), { recursive: true });
    mkdirSync(join(data, 'tmp'), { recursive: true });
    writeFileSync(join(data, 'media', 'u1', 'a.png'), 'png bytes');
    writeFileSync(join(data, 'tmp', 'half-uploaded'), 'x');
    const out = join(base, 'backup');
    mkdirSync(out);
    packData(data, out);
    const restored = join(base, 'restored');
    unpackData(out, restored);
    assert.deepEqual(inventory(restored), { files: ['media/u1/a.png'], bytes: 9 });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
