import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, PERMISSION_NAMES, Permission, type PermissionName } from './bits';
import {
  computePermissions,
  GATED_BY,
  type Level,
  type Overwrite,
  type PermissionInput,
} from './compute';
import { explainPermissions, type Reason } from './explain';

const P = Permission;

// ------------------------------------------------------------------ a small seeded random generator

function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    chance: (p: number) => next() < p,
    int: (n: number) => Math.floor(next() * n),
  };
}

// A pool that collides often: the four view bits, what depends on them, and a few unrelated ones.
const POOL: PermissionName[] = [
  'VIEW_NOTEBOOKS',
  'EDIT_PAGES',
  'DELETE_PAGES',
  'VIEW_CHANNEL',
  'SEND_MESSAGES',
  'VIEW_BOARDS',
  'CREATE_TASKS',
  'MANAGE_ROLES',
  'MANAGE_PROJECTS',
  'VIEW_CALENDAR',
  'CREATE_MEETINGS',
  'CONNECT',
];

function scenario(seed: number): PermissionInput {
  const r = rng(seed);
  const bits = (p: number): bigint => POOL.reduce((acc, n) => (r.chance(p) ? acc | P[n] : acc), 0n);
  const roleIds = ['r1', 'r2', 'r3', 'r4'];
  const roles = Object.fromEntries(
    roleIds.map((id) => [id, bits(0.25) | (r.chance(0.02) ? P.ADMINISTRATOR : 0n)]),
  );
  const pair = (): Overwrite => {
    const deny = bits(0.2);
    return { deny, allow: bits(0.2) & ~deny };
  };
  const levels = (n: number): Level[] =>
    Array.from({ length: n }, (_, i) => ({
      ref: `proj${i}`,
      ...(r.chance(0.6) && { everyone: pair() }),
      roles: Object.fromEntries(roleIds.filter(() => r.chance(0.5)).map((id) => [id, pair()])),
      ...(r.chance(0.5) && { members: { me: pair() } }),
    }));
  return {
    userId: 'me',
    ownerId: r.chance(0.03) ? 'me' : 'someone-else',
    everyone: bits(0.3) | (r.chance(0.02) ? P.ADMINISTRATOR : 0n),
    roles,
    memberRoleIds: roleIds.filter(() => r.chance(0.5)),
    chain: levels(r.int(4)),
    ...(r.chance(0.3) && { channel: levels(1)[0] }),
  };
}

// ------------------------------------------------------------------ the reference: one permission at a time, as a list of events

/** What decided the bit, in the same terms as the explanation. */
function referenceReason(
  input: PermissionInput,
  name: PermissionName,
): { granted: boolean; reason: Reason } {
  const bit = P[name];
  const has = (set: bigint) => (set & bit) !== 0n;
  const roles = input.roles ?? {};
  const held = (input.memberRoleIds ?? []).filter((id) => id in roles);

  if (input.ownerId !== null && input.userId === input.ownerId)
    return { granted: true, reason: { kind: 'owner' } };
  const adminVia = held.filter((id) => (roles[id]! & P.ADMINISTRATOR) !== 0n);
  if ((input.everyone & P.ADMINISTRATOR) !== 0n || adminVia.length)
    return {
      granted: true,
      reason: {
        kind: 'administrator',
        roleIds: (input.everyone & P.ADMINISTRATOR) !== 0n ? [] : adminVia,
      },
    };

  // The history of this one permission, oldest event first. The last one decides.
  type Event = { granted: boolean; reason: Reason };
  const events: Event[] = [];
  const baseRoles = held.filter((id) => has(roles[id]!));
  if (has(input.everyone) || baseRoles.length)
    events.push({
      granted: true,
      reason: { kind: 'base', everyone: has(input.everyone), roleIds: baseRoles },
    });

  const levels = [...(input.chain ?? []), ...(input.channel ? [input.channel] : [])];
  for (const lv of levels) {
    const ref = lv.ref ?? null;
    const push = (
      o: Overwrite | undefined,
      subject: 'everyone' | 'roles' | 'member',
      roleIds: string[] = [],
    ) => {
      if (!o) return;
      if (has(o.deny))
        events.push({
          granted: false,
          reason: { kind: 'overwrite', level: ref, subject, roleIds, effect: 'deny' },
        });
      if (has(o.allow))
        events.push({
          granted: true,
          reason: { kind: 'overwrite', level: ref, subject, roleIds, effect: 'allow' },
        });
    };
    push(lv.everyone, 'everyone');
    // the member's roles act together: every deny of them, then every allow
    const mine = held.filter((id) => lv.roles && id in lv.roles);
    const denying = mine.filter((id) => has(lv.roles![id]!.deny));
    const allowing = mine.filter((id) => has(lv.roles![id]!.allow));
    if (denying.length)
      events.push({
        granted: false,
        reason: {
          kind: 'overwrite',
          level: ref,
          subject: 'roles',
          roleIds: denying,
          effect: 'deny',
        },
      });
    if (allowing.length)
      events.push({
        granted: true,
        reason: {
          kind: 'overwrite',
          level: ref,
          subject: 'roles',
          roleIds: allowing,
          effect: 'allow',
        },
      });
    push(lv.members?.[input.userId], 'member');
  }

  const last = events.at(-1);
  const granted = last?.granted ?? false;
  if (!granted) return { granted: false, reason: last?.reason ?? { kind: 'none' } };
  return { granted: true, reason: last!.reason };
}

/** Applies the "no VIEW_ bit, no use" mask on top of the reference, given the resolved set before masking. */
function referenceAll(input: PermissionInput) {
  const raw = new Map(PERMISSION_NAMES.map((n) => [n, referenceReason(input, n)]));
  if (
    raw.get('ADMINISTRATOR')!.reason.kind === 'owner' ||
    raw.get('ADMINISTRATOR')!.reason.kind === 'administrator'
  )
    return raw;
  const viewOn = (view: bigint) => {
    const n = PERMISSION_NAMES.find((x) => P[x] === view)!;
    return raw.get(n)!.granted;
  };
  for (const { view, dependents } of GATED_BY) {
    if (viewOn(view)) continue;
    const missing = PERMISSION_NAMES.find((x) => P[x] === view)!;
    for (const n of PERMISSION_NAMES) {
      const d = raw.get(n)!;
      if (d.granted && (dependents & P[n]) !== 0n)
        raw.set(n, { granted: false, reason: { kind: 'masked', missing } });
    }
  }
  return raw;
}

const sorted = (r: Reason): Reason =>
  ('roleIds' in r ? { ...r, roleIds: [...r.roleIds].sort() } : r) as Reason;

describe('explainPermissions', () => {
  it('agrees with computePermissions and names the deciding step for every permission (5000 random scenarios)', () => {
    for (let seed = 1; seed <= 5000; seed++) {
      const input = scenario(seed);
      const got = explainPermissions(input);
      expect(got.permissions, `seed ${seed}`).toBe(computePermissions(input));
      const expected = referenceAll(input);
      for (const d of got.decisions) {
        const want = expected.get(d.permission)!;
        // the explanation says "granted" exactly where the resolved bit is set
        expect(d.granted, `seed ${seed} ${d.permission}`).toBe(
          (got.permissions & P[d.permission]) !== 0n,
        );
        expect(d.granted, `seed ${seed} ${d.permission} vs reference`).toBe(want.granted);
        expect(sorted(d.reason), `seed ${seed} ${d.permission} reason`).toEqual(
          sorted(want.reason),
        );
      }
    }
  });

  it('lists every permission once, in order', () => {
    const e = explainPermissions({ userId: 'u', ownerId: null, everyone: 0n });
    expect(e.decisions.map((d) => d.permission)).toEqual(PERMISSION_NAMES);
    expect(e.decisions.every((d) => !d.granted && d.reason.kind === 'none')).toBe(true);
  });

  it('says who decided: owner, administrator, base, overwrite, mask', () => {
    const base: PermissionInput = {
      userId: 'me',
      ownerId: 'boss',
      everyone: P.VIEW_NOTEBOOKS | P.EDIT_PAGES,
      roles: { dev: P.VIEW_BOARDS | P.CREATE_TASKS, adm: P.ADMINISTRATOR },
      memberRoleIds: ['dev'],
      chain: [
        {
          ref: 'p1',
          everyone: { allow: 0n, deny: P.EDIT_PAGES },
          roles: { dev: { allow: P.EDIT_PAGES, deny: 0n } },
        },
      ],
    };
    const decision = (input: PermissionInput, name: PermissionName) =>
      explainPermissions(input).decisions.find((d) => d.permission === name)!;

    expect(decision({ ...base, userId: 'boss' }, 'EDIT_PAGES').reason).toEqual({ kind: 'owner' });
    expect(decision({ ...base, memberRoleIds: ['dev', 'adm'] }, 'EDIT_PAGES').reason).toEqual({
      kind: 'administrator',
      roleIds: ['adm'],
    });
    expect(decision(base, 'VIEW_NOTEBOOKS').reason).toEqual({
      kind: 'base',
      everyone: true,
      roleIds: [],
    });
    expect(decision(base, 'CREATE_TASKS')).toEqual({
      permission: 'CREATE_TASKS',
      granted: true,
      reason: { kind: 'base', everyone: false, roleIds: ['dev'] },
    });
    // @everyone is denied EDIT_PAGES in p1, the dev role allows it again: the role decides
    expect(decision(base, 'EDIT_PAGES')).toEqual({
      permission: 'EDIT_PAGES',
      granted: true,
      reason: {
        kind: 'overwrite',
        level: 'p1',
        subject: 'roles',
        roleIds: ['dev'],
        effect: 'allow',
      },
    });
    // without the allow the @everyone deny stands
    const noDev = { ...base, memberRoleIds: [] };
    expect(decision(noDev, 'EDIT_PAGES')).toEqual({
      permission: 'EDIT_PAGES',
      granted: false,
      reason: { kind: 'overwrite', level: 'p1', subject: 'everyone', roleIds: [], effect: 'deny' },
    });
    // a deny that removes the view bit masks what depends on it
    const hidden: PermissionInput = {
      ...base,
      chain: [{ ref: 'p1', everyone: { allow: 0n, deny: P.VIEW_NOTEBOOKS } }],
    };
    expect(decision(hidden, 'VIEW_NOTEBOOKS').reason).toMatchObject({
      kind: 'overwrite',
      effect: 'deny',
      subject: 'everyone',
    });
    expect(decision(hidden, 'EDIT_PAGES')).toMatchObject({
      granted: false,
      reason: { kind: 'masked', missing: 'VIEW_NOTEBOOKS' },
    });
  });

  it('a member allow beats a role deny on the same level, and says so', () => {
    const e = explainPermissions({
      userId: 'me',
      ownerId: null,
      everyone: P.VIEW_NOTEBOOKS | P.EDIT_PAGES,
      roles: { r: 0n },
      memberRoleIds: ['r'],
      chain: [
        {
          ref: 'p',
          roles: { r: { allow: 0n, deny: P.EDIT_PAGES } },
          members: { me: { allow: P.EDIT_PAGES, deny: 0n } },
        },
      ],
    });
    expect(e.decisions.find((d) => d.permission === 'EDIT_PAGES')).toMatchObject({
      granted: true,
      reason: { kind: 'overwrite', subject: 'member', effect: 'allow', level: 'p' },
    });
    expect(e.permissions & P.EDIT_PAGES).toBe(P.EDIT_PAGES);
    expect(ALL_PERMISSIONS & e.permissions).toBe(e.permissions);
  });
});
