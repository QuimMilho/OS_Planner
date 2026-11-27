// When the desktop app may restart itself to install a downloaded update (the decision is a pure function).
//   npm run test -w @os-planner/desktop      (needs the desktop built: `npx tsc -p apps/desktop/tsconfig.json`)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { shouldInstallNow } from '../dist/updater-policy.js';

const quiet = { webBusy: false, visible: true, minimized: false, focused: true, idleSeconds: 0 };

describe('silent update policy', () => {
  test('never while the website says there is a call, a dialog or unsaved work', () => {
    assert.equal(shouldInstallNow({ ...quiet, webBusy: true, minimized: true, idleSeconds: 99_999 }), false);
    assert.equal(shouldInstallNow({ ...quiet, webBusy: true, visible: false, focused: false, idleSeconds: 99_999 }), false);
  });

  test('not while someone is using the window', () => {
    assert.equal(shouldInstallNow(quiet), false);
    assert.equal(shouldInstallNow({ ...quiet, idleSeconds: 14 * 60 }), false);
    // a window nobody is looking at but the computer is in use: wait for the 5 minutes
    assert.equal(shouldInstallNow({ ...quiet, focused: false, idleSeconds: 4 * 60 }), false);
  });

  test('when the window is minimised or hidden', () => {
    assert.equal(shouldInstallNow({ ...quiet, minimized: true }), true);
    assert.equal(shouldInstallNow({ ...quiet, visible: false, focused: false }), true);
  });

  test('when the computer has been left alone', () => {
    assert.equal(shouldInstallNow({ ...quiet, focused: false, idleSeconds: 5 * 60 }), true);
    assert.equal(shouldInstallNow({ ...quiet, idleSeconds: 15 * 60 }), true);
  });
});
