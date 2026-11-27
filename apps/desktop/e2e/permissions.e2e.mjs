// The rules for what the window's page may ask the computer for (unit test of dist/permissions.js; no window needed).
//   npm run test -w @os-planner/desktop      (needs a build of the desktop app)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

const { mayUse, originOf } = createRequire(import.meta.url)(
  resolve(import.meta.dirname, '../dist/permissions.js'),
);
const SITE = 'https://planner.example.com';

describe('window permissions', () => {
  test('the microphone, camera and screen go only to the OS_Planner site', () => {
    for (const permission of ['media', 'display-capture']) {
      assert.equal(mayUse(permission, `${SITE}/app/v/abc`, SITE), true, permission);
      assert.equal(mayUse(permission, SITE, SITE), true, `${permission} (an origin)`);
      assert.equal(
        mayUse(permission, 'https://evil.example.com/app', SITE),
        false,
        `${permission} other host`,
      );
      assert.equal(
        mayUse(permission, 'http://planner.example.com/', SITE),
        false,
        `${permission} other scheme`,
      );
      assert.equal(
        mayUse(permission, 'https://planner.example.com:8443/', SITE),
        false,
        `${permission} other port`,
      );
      assert.equal(
        mayUse(permission, 'https://planner.example.com.evil.test/', SITE),
        false,
        `${permission} look-alike`,
      );
      assert.equal(
        mayUse(permission, 'file:///C:/page.html', SITE),
        false,
        `${permission} a local file`,
      );
      assert.equal(mayUse(permission, '', SITE), false, `${permission} unknown asker`);
      assert.equal(mayUse(permission, undefined, SITE), false);
      assert.equal(mayUse(permission, `${SITE}/`, null), false, `${permission} no site`);
    }
  });

  test('clipboard and fullscreen stay as they were; everything else is refused, whoever asks', () => {
    assert.equal(mayUse('clipboard-sanitized-write', 'https://other.example.com', SITE), true);
    assert.equal(mayUse('fullscreen', SITE, SITE), true);
    for (const permission of [
      'geolocation',
      'notifications',
      'midi',
      'usb',
      'serial',
      'clipboard-read',
      'openExternal',
      'mediaKeySystem',
      'unknown',
    ])
      assert.equal(mayUse(permission, SITE, SITE), false, permission);
  });

  test('originOf reads addresses and nothing else', () => {
    assert.equal(originOf('https://planner.example.com/a/b?c#d'), SITE);
    assert.equal(originOf('not a url'), null);
    assert.equal(originOf(undefined), null);
  });
});
