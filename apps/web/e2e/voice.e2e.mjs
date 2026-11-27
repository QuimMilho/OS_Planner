// End-to-end: voice and video channels. The real app in real Chrome (with fake microphone and camera) against the real server and a real
// LiveKit media server in a docker container.
//   npm run e2e          (needs `docker compose up -d mysql mailpit`, a build, and docker with the livekit/livekit-server image)
// Without docker or the image the voice tests are skipped (and say so); the "voice is off" test needs neither.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright-core';
import { register, sql, startStack, uniqueEmail, verify } from './harness.mjs';

const T = { timeout: 300_000 };
const ADMIN_EMAIL = uniqueEmail('voiceadmin');
const KEY = 'APIe2ekey';
const SECRET = 'e2e-livekit-secret-0123456789-abcdefghij';
const NAME = 'os-planner-e2e-livekit';
const STACK_PORT = 3100;
const BIT = {
  CONNECT: 1n << 33n,
  SPEAK: 1n << 34n,
  VIDEO: 1n << 35n,
  SCREEN_SHARE: 1n << 36n,
  MUTE_MEMBERS: 1n << 37n,
  MOVE_MEMBERS: 1n << 38n,
};
const EVERYONE_VOICE = BIT.CONNECT | BIT.SPEAK | BIT.VIDEO | BIT.SCREEN_SHARE;

function dockerReady() {
  try {
    execFileSync('docker', ['image', 'inspect', 'livekit/livekit-server'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const SKIP = process.env.E2E_BASE_URL
  ? 'E2E_BASE_URL is set (the media server cannot be started)'
  : process.env.E2E_NO_VOICE
    ? 'E2E_NO_VOICE is set'
    : dockerReady()
      ? false
      : 'docker or the livekit/livekit-server image is not available';

function startLiveKit() {
  try {
    execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
  } catch {
    /* none running */
  }
  const config = [
    'port: 7880',
    'rtc:',
    '  tcp_port: 7881',
    '  udp_port: 7882',
    '  node_ip: 127.0.0.1',
    '  use_external_ip: false',
    'keys:',
    `  ${KEY}: ${SECRET}`,
    'webhook:',
    `  api_key: ${KEY}`,
    '  urls:',
    `    - http://host.docker.internal:${STACK_PORT}/api/voice/webhook`,
    '',
  ].join('\n');
  // create + start (not `docker run -d`, which has been seen to hang on Docker Desktop for Windows while publishing the UDP port)
  execFileSync(
    'docker',
    [
      'create',
      '--name',
      NAME,
      '-p',
      '7880:7880',
      '-p',
      '7881:7881',
      '-p',
      '7882:7882/udp',
      '--add-host',
      'host.docker.internal:host-gateway',
      '-e',
      `LIVEKIT_CONFIG=${config}`,
      'livekit/livekit-server',
    ],
    { stdio: 'ignore', timeout: 60_000 },
  );
  execFileSync('docker', ['start', NAME], { stdio: 'ignore', timeout: 60_000 });
}
function stopLiveKit() {
  try {
    execFileSync('docker', ['rm', '-f', NAME], { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
}
async function waitForLiveKit() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('http://localhost:7880', { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the media server did not start');
}

let stack;
let browser;
let base;
let adminOnce;

const FLAGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen',
  '--autoplay-policy=no-user-gesture-required',
];

async function open() {
  return chromium.launch({ channel: 'chrome', headless: true, args: FLAGS });
}

async function device() {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 1000 },
    permissions: ['microphone', 'camera'],
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  const problems = [];
  page.on(
    'console',
    (m) =>
      /Content Security Policy|violates the following/i.test(m.text()) &&
      problems.push(m.text().slice(0, 200)),
  );
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`));
  return { ctx, page, problems, close: async () => ctx.close() };
}

async function account(name, wanted) {
  const d = await device();
  const { email } = await register(d.page, base, { name, ...(wanted ? { email: wanted } : {}) });
  await verify(d.page, email);
  await d.page.goto(`${base}/app`);
  await d.page.waitForSelector('app-rail');
  const id = (await sql('SELECT id FROM `User` WHERE email = ?', [email]))[0].id;
  return { ...d, email, id, name };
}
const getAdmin = () => (adminOnce ??= account('The Admin', ADMIN_EMAIL));

async function createTeam(admin, name, owner) {
  await admin.page.goto(`${base}/app/admin`);
  await admin.page.waitForSelector('[data-admin-teams]');
  await admin.page.fill('input[name=teamName]', name);
  await admin.page.fill('input[name=teamOwner]', owner.email);
  await admin.page.click('[data-create-team]');
  await admin.page.locator(`[data-team-row="${name}"]`).waitFor();
  return (await sql('SELECT id FROM `Team` WHERE name = ?', [name]))[0].id;
}
const joinTeam = (teamId, who) =>
  sql('INSERT INTO `TeamMember` (teamId, userId, joinedAt) VALUES (?, ?, NOW(3))', [
    teamId,
    who.id,
  ]);

async function api(page, method, path, body) {
  return page.evaluate(
    async ([m, p, b]) => {
      const refresh = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'X-Requested-With': 'os_planner' },
      });
      const { accessToken } = await refresh.json();
      const res = await fetch(p, {
        method: m,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(b ? { 'Content-Type': 'application/json' } : {}),
        },
        body: b ? JSON.stringify(b) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    [method, path, body ?? null],
  );
}

async function answerPrompt(page, text) {
  const box = page.locator('mat-dialog-container input');
  await box.waitFor();
  await box.fill(text);
  await box.press('Enter');
  await page.waitForSelector('mat-dialog-container', { state: 'detached' });
}

/** The owner makes a voice channel through the sidebar menu; returns its id (read from the address). */
async function newVoiceChannel(owner, teamId, name) {
  await owner.page.goto(`${base}/app/t/${teamId}`);
  await owner.page.waitForSelector('[data-channel-list]');
  await owner.page.click('[data-action=new-channel-menu]');
  await owner.page.click('[data-action=new-voice-channel]');
  await answerPrompt(owner.page, name);
  await owner.page.waitForURL(/\/app\/v\/[0-9a-f-]{36}$/);
  await owner.page.waitForSelector('[data-voice-page]');
  return owner.page.url().split('/').pop();
}

const tile = (page, who) => page.locator(`[data-voice-tile][data-user="${who.id}"]`).first();

/** Goes to the channel and joins its call. */
async function joinCall(who, channelId) {
  await who.page.goto(`${base}/app/v/${channelId}`);
  await who.page.waitForSelector('[data-voice-join]').catch(async (e) => {
    const text = await who.page.locator('body').innerText().catch(() => '?');
    throw new Error(`${e.message}\nthe page said:\n${text.slice(0, 600)}`);
  });
  await who.page.click('[data-voice-join]');
  await who.page.locator('[data-voice-stage]').waitFor();
  await who.page.locator('[data-voice-bar], [data-voice-stage]').first().waitFor();
}

/** A team where everyone may talk: an owner, three members. */
async function setup(name, extraMembers = 3) {
  const admin = await getAdmin();
  const owner = await account('Olga Owner');
  const members = [];
  for (let i = 0; i < extraMembers; i++)
    members.push(await account(['Ben', 'Cleo', 'Dan'][i] ?? `M${i}`));
  const teamId = await createTeam(admin, name, owner);
  for (const m of members) await joinTeam(teamId, m);
  await sql('UPDATE `Role` SET permissions = permissions | ? WHERE teamId = ? AND isEveryone = 1', [
    EVERYONE_VOICE.toString(),
    teamId,
  ]);
  return { owner, members, teamId };
}

before(async () => {
  if (!SKIP) startLiveKit();
  stack = await startStack({
    port: STACK_PORT,
    // with no media server running, the address still answers nothing: the screens that need only the server's own list still work
    env: {
      ADMIN_EMAILS: ADMIN_EMAIL,
      LIVEKIT_URL: 'ws://localhost:7880',
      LIVEKIT_API_KEY: KEY,
      LIVEKIT_API_SECRET: SECRET,
      VOICE_CHECK_SECONDS: '5',
    },
  });
  base = stack.baseUrl;
  browser = await open();
  if (!SKIP) await waitForLiveKit();
});
after(async () => {
  await (await adminOnce)?.close();
  await browser?.close();
  await stack?.stop();
  stopLiveKit();
});

describe('voice', { skip: SKIP }, () => {
  test(
    'two people join one voice channel and see each other and who is speaking; mute works; somebody who is not connected sees who is in it',
    T,
    async () => {
      const { owner, members, teamId } = await setup('Voice Team One');
      const [ben, cleo] = members;
      const channelId = await newVoiceChannel(owner, teamId, 'Lounge');

      await joinCall(owner, channelId);
      await joinCall(ben, channelId);
      await tile(owner.page, ben).waitFor();
      await tile(ben.page, owner).waitFor();
      await owner.page
        .locator('[data-voice-bar][data-state=connected]')
        .first()
        .waitFor()
        .catch(() => undefined);
      // the fake microphone makes a beep now and then: the other side sees the speaking ring
      await ben.page
        .locator(`[data-voice-tile][data-user="${owner.id}"][data-speaking=true]`)
        .first()
        .waitFor({ timeout: 30_000 });

      // muting: the other page sees the microphone go off
      assert.equal(await tile(ben.page, owner).getAttribute('data-mic'), 'true');
      await owner.page.click('[data-voice-mute]');
      await ben.page
        .locator(`[data-voice-tile][data-user="${owner.id}"][data-mic=false]`)
        .first()
        .waitFor();
      await owner.page.click('[data-voice-mute]');
      await ben.page
        .locator(`[data-voice-tile][data-user="${owner.id}"][data-mic=true]`)
        .first()
        .waitFor();

      // Cleo is not connected: the sidebar still shows who is in the channel, and follows them leaving
      await cleo.page.goto(`${base}/app/t/${teamId}`);
      await cleo.page.waitForSelector('[data-channel-list]');
      await cleo.page.locator('[data-voice-participant]').nth(1).waitFor();
      assert.equal(await cleo.page.locator('[data-voice-participant]').count(), 2);
      await ben.page.click('[data-voice-leave]');
      await cleo.page.waitForFunction(
        () => document.querySelectorAll('[data-voice-participant]').length === 1,
      );
      await owner.page.click('[data-voice-leave]');
      await cleo.page.waitForFunction(
        () => document.querySelectorAll('[data-voice-participant]').length === 0,
      );

      // the team's other people never saw a policy error on the way
      for (const d of [owner, ben, cleo]) assert.deepEqual(d.problems, []);
      for (const d of [owner, ...members]) await d.close();
    },
  );

  test(
    'somebody without SPEAK joins muted and cannot unmute; a moderator server-mutes someone, who sees the reason; moving a person works',
    T,
    async () => {
      const { owner, members, teamId } = await setup('Voice Team Two');
      const [ben, cleo, dan] = members;
      const lounge = await newVoiceChannel(owner, teamId, 'Lounge');
      const quiet = await newVoiceChannel(owner, teamId, 'Quiet');
      await sql(
        "INSERT INTO `Overwrite` (id, targetKind, targetId, subjectKind, subjectId, allow, deny) VALUES (UUID(), 'channel', ?, 'member', ?, 0, ?)",
        [lounge, dan.id, BIT.SPEAK.toString()],
      );

      await joinCall(owner, lounge);
      await joinCall(ben, lounge);
      await joinCall(dan, lounge);
      await joinCall(cleo, lounge);

      // Dan may listen, not speak
      await dan.page.locator('[data-voice-listen-only]').waitFor();
      assert.equal(await dan.page.locator('[data-voice-mute]').first().isDisabled(), true);
      await tile(ben.page, dan).waitFor();
      assert.equal(await tile(ben.page, dan).getAttribute('data-mic'), 'false');
      assert.equal(await tile(dan.page, ben).getAttribute('data-mic'), 'true'); // and hears: Ben's tile shows a live microphone

      // The owner mutes Ben from the tile menu: Ben is told, cannot unmute, and the others see the badge
      await tile(owner.page, ben).hover();
      await tile(owner.page, ben).locator('[data-voice-moderate]').click();
      await owner.page.locator('.mat-mdc-menu-panel [data-voice-action=mute]').click();
      await ben.page.locator('[data-voice-modmuted]').waitFor();
      assert.equal(await ben.page.locator('[data-voice-mute]').first().isDisabled(), true);
      await tile(cleo.page, ben).locator('[data-voice-modbadge]').waitFor();
      // ...and the owner lets Ben speak again
      await tile(owner.page, ben).hover();
      await tile(owner.page, ben).locator('[data-voice-moderate]').click();
      await owner.page.locator('.mat-mdc-menu-panel [data-voice-action=unmute]').click();
      await ben.page.locator('[data-voice-modmuted]').waitFor({ state: 'detached' });
      await ben.page.waitForFunction(() => !document.querySelector('[data-voice-mute]')?.disabled);

      // Moving Cleo to #Quiet: her page follows and she is in the other channel's list
      await tile(owner.page, cleo).hover();
      await tile(owner.page, cleo).locator('[data-voice-moderate]').click();
      await owner.page
        .locator('.mat-mdc-menu-panel [data-voice-action=move][data-to="Quiet"]')
        .click();
      await cleo.page.waitForURL(new RegExp(`/app/v/${quiet}$`));
      await cleo.page.locator('[data-voice-stage]').waitFor();
      await tile(cleo.page, cleo).waitFor();
      await tile(owner.page, cleo).waitFor({ state: 'detached' });

      // Disconnecting Dan ends his call
      await tile(owner.page, dan).hover();
      await tile(owner.page, dan).locator('[data-voice-moderate]').click();
      await owner.page.locator('.mat-mdc-menu-panel [data-voice-action=disconnect]').click();
      await dan.page.locator('[data-voice-join]').waitFor();
      const left = await sql('SELECT COUNT(*) AS n FROM `VoiceParticipant` WHERE userId = ?', [
        dan.id,
      ]);
      assert.equal(Number(left[0].n), 0);
      const audit = await sql(
        "SELECT action FROM `AuditLog` WHERE teamId = ? AND action LIKE 'voice.%' ORDER BY id",
        [teamId],
      );
      assert.deepEqual(
        audit.map((a) => a.action),
        ['voice.mute', 'voice.unmute', 'voice.move', 'voice.disconnect'],
      );
      for (const d of [owner, ...members]) await d.close();
    },
  );

  test('a shared screen shows up for the other person, and leaving ends it', T, async () => {
    const { owner, members, teamId } = await setup('Voice Team Three', 1);
    const [ben] = members;
    const channelId = await newVoiceChannel(owner, teamId, 'Lounge');
    await joinCall(owner, channelId);
    await joinCall(ben, channelId);
    await tile(ben.page, owner).waitFor();

    await owner.page.click('[data-voice-share]');
    await owner.page
      .locator('[data-voice-bar][data-state=connected], [data-voice-stage]')
      .first()
      .waitFor();
    await ben.page
      .locator('[data-voice-focus] video[data-voice-video=screen]')
      .waitFor({ timeout: 30_000 });
    assert.equal(await tile(ben.page, owner).getAttribute('data-screen'), 'true');
    // the person sharing is always told it is on
    await owner.page.locator('[data-voice-share][aria-pressed=true]').first().waitFor();

    await owner.page.click('[data-voice-leave]');
    await ben.page.locator('[data-voice-focus]').waitFor({ state: 'detached' });
    assert.equal(await ben.page.locator(`[data-voice-tile][data-user="${owner.id}"]`).count(), 0);
    for (const d of [owner, ...members]) await d.close();
  });

  test('removing CONNECT disconnects the person within seconds', T, async () => {
    const { owner, members, teamId } = await setup('Voice Team Four', 1);
    const [ben] = members;
    const channelId = await newVoiceChannel(owner, teamId, 'Lounge');
    await joinCall(owner, channelId);
    await joinCall(ben, channelId);
    await tile(owner.page, ben).waitFor();
    const res = await api(owner.page, 'PUT', '/api/overwrites', {
      targetKind: 'channel',
      targetId: channelId,
      subjectKind: 'member',
      subjectId: ben.id,
      allow: '0',
      deny: BIT.CONNECT.toString(),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await ben.page
      .locator('[data-voice-join], [data-voice-no-permission]')
      .first()
      .waitFor({ timeout: 10_000 });
    await tile(owner.page, ben).waitFor({ state: 'detached', timeout: 10_000 });
    for (const d of [owner, ...members]) await d.close();
  });
});

/** A webhook as the media server sends it (a signed JWT over the exact body). */
async function webhook(event) {
  const body = JSON.stringify({
    id: `EV_${Math.random().toString(36).slice(2)}`,
    createdAt: Math.floor(Date.now() / 1000),
    ...event,
  });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const claims = b64({
    iss: KEY,
    exp: Math.floor(Date.now() / 1000) + 300,
    sha256: createHash('sha256').update(body).digest('base64'),
  });
  const sig = createHmac('sha256', SECRET).update(`${head}.${claims}`).digest('base64url');
  const res = await fetch(`${base}/api/voice/webhook`, {
    method: 'POST',
    headers: {
      Authorization: `${head}.${claims}.${sig}`,
      'Content-Type': 'application/webhook+json',
    },
    body,
  });
  assert.equal(res.status, 200);
}

// These need no media server: they check what the website does around a call (the channel, the list of who is in it, the settings, what is
// refused), with the server's own list of participants fed by signed webhooks.
describe(
  'voice without a reachable media server',
  { skip: SKIP ? false : 'covered by the full voice tests' },
  () => {
    test(
      'voice channels are made and listed, the list of who is in them follows the server, and a failed join says so and leaves nothing behind',
      T,
      async () => {
        const { owner, members, teamId } = await setup('Voice Team Five', 2);
        const [ben, cleo] = members;
        const lounge = await newVoiceChannel(owner, teamId, 'Lounge');
        await owner.page.goto(`${base}/app/t/${teamId}`);
        await owner.page.locator('[data-voice-row][data-channel-row="Lounge"]').waitFor();

        // the settings of a voice channel: limit and quality
        await owner.page.goto(`${base}/app/c/${lounge}/settings`);
        await owner.page.fill('[data-field=user-limit]', '3');
        await owner.page.selectOption('[data-field=quality]', { label: 'High' });
        await owner.page.click('[data-action=save-channel]');
        await owner.page.waitForFunction(
          () => !document.querySelector('[data-action=save-channel]')?.disabled,
        );
        const row = (
          await sql('SELECT userLimit, quality FROM `Channel` WHERE id = ?', [lounge])
        )[0];
        assert.deepEqual({ ...row }, { userLimit: 3, quality: 'high' });

        // people the media server reports show in the sidebar of somebody who is not in the call, and leave it again
        await cleo.page.goto(`${base}/app/t/${teamId}`);
        await cleo.page.waitForSelector('[data-channel-list]');
        await webhook({
          event: 'participant_joined',
          room: { name: lounge },
          participant: { sid: 'PA_b', identity: ben.id, joinedAt: Math.floor(Date.now() / 1000) },
        });
        await cleo.page.locator(`[data-voice-participant][data-user="${ben.id}"]`).waitFor();
        await cleo.page.click('[data-voice-row] a.name');
        await cleo.page.locator('[data-voice-people] [data-user]').first().waitFor();
        assert.equal(
          (await cleo.page.textContent('[data-voice-count]')).trim(),
          '1 in the channel',
        );
        await webhook({
          event: 'participant_left',
          room: { name: lounge },
          participant: { sid: 'PA_b', identity: ben.id },
        });
        await cleo.page.waitForFunction(
          () => document.querySelectorAll('[data-voice-participant]').length === 0,
        );

        // a hidden channel is not listed: Cleo may not see it, so she is not told who is in it
        await sql(
          "INSERT INTO `Overwrite` (id, targetKind, targetId, subjectKind, subjectId, allow, deny) VALUES (UUID(), 'channel', ?, 'member', ?, 0, ?)",
          [lounge, cleo.id, (1n << 7n).toString()],
        );
        await cleo.page.reload();
        await cleo.page.waitForSelector('[data-channel-list]');
        assert.equal(await cleo.page.locator('[data-voice-row]').count(), 0);
        await sql('DELETE FROM `Overwrite` WHERE targetId = ?', [lounge]);

        // joining while the media server cannot be reached: an error, no half-open call, no bar
        await ben.page.goto(`${base}/app/v/${lounge}`);
        await ben.page.click('[data-voice-join]');
        await ben.page.locator('.mat-mdc-snack-bar-container').waitFor();
        await ben.page.locator('[data-voice-join]').waitFor();
        assert.equal(await ben.page.locator('[data-voice-bar]').count(), 0);

        // a person who may not connect is told so instead of being offered a button
        await sql(
          'UPDATE `Role` SET permissions = permissions & ~? WHERE teamId = ? AND isEveryone = 1',
          [BIT.CONNECT.toString(), teamId],
        );
        await ben.page.reload();
        await ben.page.locator('[data-voice-no-permission]').waitFor({ timeout: 30_000 });
        assert.equal(await ben.page.locator('[data-voice-join]').count(), 0);

        // Settings has the voice section with the device pickers
        await ben.page.goto(`${base}/app/settings`);
        await ben.page.locator('#voice [data-voice-settings] [data-field=voice-mic]').waitFor();
        await ben.page.locator('#voice [data-field=voice-ptt]').check();
        await ben.page.locator('[data-voice-ptt-key]').waitFor();
        for (const d of [owner, ...members]) assert.deepEqual(d.problems, []);
        for (const d of [owner, ...members]) await d.close();
      },
    );
  },
);

describe('voice off', () => {
  test(
    'without a media server there is no voice option anywhere and the API says so',
    T,
    async () => {
      // a server without LIVEKIT_*: restart the stack
      await stack.stop();
      stack = await startStack({
        port: STACK_PORT,
        env: {
          ADMIN_EMAILS: ADMIN_EMAIL,
          LIVEKIT_URL: '',
          LIVEKIT_API_KEY: '',
          LIVEKIT_API_SECRET: '',
        },
      });
      base = stack.baseUrl;
      adminOnce = undefined; // the database was reset: nobody is known any more
      const admin = await getAdmin();
      const owner = await account('Quiet Owner');
      const teamId = await createTeam(admin, 'Voice Team Off', owner);
      assert.equal((await (await fetch(`${base}/api/features`)).json()).voice, false);

      await owner.page.goto(`${base}/app/t/${teamId}`);
      await owner.page.waitForSelector('[data-channel-list]');
      await owner.page.click('[data-action=new-channel-menu]');
      await owner.page.locator('[data-action=new-channel]').waitFor();
      assert.equal(await owner.page.locator('[data-action=new-voice-channel]').count(), 0);
      await owner.page.keyboard.press('Escape');
      await owner.page.goto(`${base}/app/settings`);
      await owner.page.waitForSelector('#storage');
      assert.equal(await owner.page.locator('#voice, [data-voice-settings]').count(), 0);
      assert.equal(await owner.page.locator('[data-voice-bar]').count(), 0);
      const channel = await api(
        owner.page,
        'POST',
        `/api/spaces/${(await sql('SELECT spaceId FROM `Team` WHERE id = ?', [teamId]))[0].spaceId}/channels`,
        { name: 'v', kind: 'voice' },
      );
      assert.equal(channel.status, 422);
      await owner.close();
      await (await adminOnce)?.close();
    },
  );
});
