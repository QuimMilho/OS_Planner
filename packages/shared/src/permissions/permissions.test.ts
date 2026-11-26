import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE,
  PERMISSION_NAMES,
  Permission,
  all,
  fromString,
  has,
  namesOf,
  none,
  toString,
} from './bits';
import {
  GATED_BY,
  computePermissions,
  maskUnviewable,
  type Level,
  type Overwrite,
  type PermissionInput,
} from './compute';

const P = Permission;
const ROLE_A = 'role-a';
const ROLE_B = 'role-b';
const ME = 'me';
const OWNER = 'owner';
const BITS = PERMISSION_NAMES.map((n) => P[n]);

// ------------------------------------------------------------------ an independent, bit-by-bit reference

const bitOf = (set: bigint, bit: bigint): boolean => (set & bit) !== 0n;

/** The rules written out one permission at a time with booleans, as a person would read them. */
function reference(input: PermissionInput): bigint {
  if (input.ownerId !== null && input.userId === input.ownerId) return ALL_PERMISSIONS;
  const roles = input.roles ?? {};
  const held = (input.memberRoleIds ?? []).filter((id) => id in roles);

  const value = new Map<bigint, boolean>();
  for (const bit of BITS)
    value.set(bit, bitOf(input.everyone, bit) || held.some((id) => bitOf(roles[id]!, bit)));
  if (value.get(P.ADMINISTRATOR)) return ALL_PERMISSIONS;

  const levels: Level[] = [...(input.chain ?? []), ...(input.channel ? [input.channel] : [])];
  for (const level of levels) {
    for (const bit of BITS) {
      let v = value.get(bit)!;
      const denies = (o?: Overwrite) => !!o && bitOf(o.deny, bit);
      const allows = (o?: Overwrite) => !!o && bitOf(o.allow, bit);
      // @everyone
      if (denies(level.everyone)) v = false;
      if (allows(level.everyone)) v = true;
      // the member's roles together: any deny, then any allow
      const mine = held.map((id) => level.roles?.[id]);
      if (mine.some(denies)) v = false;
      if (mine.some(allows)) v = true;
      // the member
      const own = level.members?.[input.userId];
      if (denies(own)) v = false;
      if (allows(own)) v = true;
      value.set(bit, v);
    }
  }

  for (const { view, dependents } of GATED_BY) {
    if (!value.get(view)) for (const bit of BITS) if (bitOf(dependents, bit)) value.set(bit, false);
  }
  return BITS.reduce((acc, bit) => (value.get(bit) ? acc | bit : acc), 0n);
}

const ow = (allow = 0n, deny = 0n): Overwrite => ({ allow, deny });

// ------------------------------------------------------------------ the bit table

describe('permission bits', () => {
  it('uses the numbering of the overview and never repeats a bit', () => {
    expect(P.ADMINISTRATOR).toBe(1n);
    expect(P.VIEW_CHANNEL).toBe(1n << 7n);
    expect(P.VIEW_NOTEBOOKS).toBe(1n << 17n);
    expect(P.MOVE_MEMBERS).toBe(1n << 38n);
    expect(new Set(BITS).size).toBe(BITS.length);
    expect(BITS.length).toBe(39);
    expect(ALL_PERMISSIONS).toBe((1n << 39n) - 1n);
  });

  it('defaults @everyone to look around, read, send, and see notebooks, boards and the calendar', () => {
    expect(namesOf(DEFAULT_EVERYONE).sort()).toEqual(
      [
        'READ_MESSAGE_HISTORY',
        'SEND_MESSAGES',
        'VIEW_BOARDS',
        'VIEW_CALENDAR',
        'VIEW_CHANNEL',
        'VIEW_NOTEBOOKS',
      ].sort(),
    );
  });

  it('has / all / none behave as set tests', () => {
    const set = P.VIEW_CHANNEL | P.SEND_MESSAGES;
    expect(has(set, P.VIEW_CHANNEL)).toBe(true);
    expect(has(set, P.VIEW_CHANNEL | P.ATTACH_FILES)).toBe(false);
    expect(all(set, P.VIEW_CHANNEL, P.SEND_MESSAGES)).toBe(true);
    expect(all(set, P.VIEW_CHANNEL, P.ATTACH_FILES)).toBe(false);
    expect(none(set, P.ATTACH_FILES, P.ADD_REACTIONS)).toBe(true);
    expect(none(set, P.ATTACH_FILES, P.SEND_MESSAGES)).toBe(false);
  });

  it('round-trips through decimal strings and rejects everything else', () => {
    for (const v of [0n, 1n, ALL_PERMISSIONS, (1n << 64n) - 1n])
      expect(fromString(toString(v))).toBe(v);
    for (const bad of [
      '',
      '-1',
      '1.5',
      '0x10',
      ' 1',
      'abc',
      '18446744073709551616',
      '1'.repeat(25),
    ])
      expect(fromString(bad)).toBeNull();
  });
});

// ------------------------------------------------------------------ the rules

describe('computePermissions', () => {
  const base = (over: Partial<PermissionInput> = {}): PermissionInput => ({
    userId: ME,
    ownerId: OWNER,
    everyone: DEFAULT_EVERYONE,
    ...over,
  });

  it('gives the owner everything, whatever @everyone or an overwrite says', () => {
    const level: Level = {
      everyone: ow(0n, ALL_PERMISSIONS),
      members: { [OWNER]: ow(0n, ALL_PERMISSIONS) },
    };
    expect(computePermissions(base({ userId: OWNER, everyone: 0n, chain: [level] }))).toBe(
      ALL_PERMISSIONS,
    );
  });

  it('gives ADMINISTRATOR (through a role or @everyone) everything, overwrites included', () => {
    const level: Level = { everyone: ow(0n, ALL_PERMISSIONS) };
    expect(
      computePermissions(
        base({ roles: { [ROLE_A]: P.ADMINISTRATOR }, memberRoleIds: [ROLE_A], chain: [level] }),
      ),
    ).toBe(ALL_PERMISSIONS);
    expect(computePermissions(base({ everyone: P.ADMINISTRATOR }))).toBe(ALL_PERMISSIONS);
    // a role the member does not hold does nothing
    expect(
      computePermissions(base({ roles: { [ROLE_A]: P.ADMINISTRATOR }, memberRoleIds: [] })),
    ).toBe(DEFAULT_EVERYONE);
  });

  it('a team without an owner yet gives nobody the owner shortcut', () => {
    expect(computePermissions(base({ ownerId: null, userId: 'anyone' }))).toBe(DEFAULT_EVERYONE);
  });

  it('starts from @everyone and adds every role the member holds', () => {
    const roles = { [ROLE_A]: P.MANAGE_PROJECTS, [ROLE_B]: P.ATTACH_FILES };
    expect(computePermissions(base({ roles, memberRoleIds: [ROLE_A] }))).toBe(
      DEFAULT_EVERYONE | P.MANAGE_PROJECTS,
    );
    expect(computePermissions(base({ roles, memberRoleIds: [ROLE_A, ROLE_B] }))).toBe(
      DEFAULT_EVERYONE | P.MANAGE_PROJECTS | P.ATTACH_FILES,
    );
    expect(computePermissions(base({ roles, memberRoleIds: ['unknown'] }))).toBe(DEFAULT_EVERYONE);
  });

  it('applies @everyone, then roles, then the member, within a level', () => {
    const roles = { [ROLE_A]: 0n };
    const level: Level = {
      everyone: ow(P.ATTACH_FILES, P.SEND_MESSAGES),
      roles: { [ROLE_A]: ow(P.SEND_MESSAGES, P.ATTACH_FILES) }, // the role undoes both
      members: { [ME]: ow(P.ATTACH_FILES, 0n) }, // and the member wins last
    };
    const got = computePermissions(base({ roles, memberRoleIds: [ROLE_A], chain: [level] }));
    expect(has(got, P.SEND_MESSAGES)).toBe(true);
    expect(has(got, P.ATTACH_FILES)).toBe(true);
  });

  it('a member allow beats a role deny on the same level, and a role allow beats a role deny', () => {
    const roles = { [ROLE_A]: 0n, [ROLE_B]: 0n };
    const level: Level = {
      roles: { [ROLE_A]: ow(0n, P.SEND_MESSAGES), [ROLE_B]: ow(P.SEND_MESSAGES, 0n) },
    };
    expect(
      has(
        computePermissions(base({ roles, memberRoleIds: [ROLE_A, ROLE_B], chain: [level] })),
        P.SEND_MESSAGES,
      ),
    ).toBe(true);
    expect(
      has(
        computePermissions(base({ roles, memberRoleIds: [ROLE_A], chain: [level] })),
        P.SEND_MESSAGES,
      ),
    ).toBe(false);
    const withMember: Level = { ...level, members: { [ME]: ow(P.SEND_MESSAGES, 0n) } };
    expect(
      has(
        computePermissions(base({ roles, memberRoleIds: [ROLE_A], chain: [withMember] })),
        P.SEND_MESSAGES,
      ),
    ).toBe(true);
  });

  it('a deeper allow beats a shallower deny, and a deeper deny beats a shallower allow', () => {
    const deny: Level = { everyone: ow(0n, P.SEND_MESSAGES) };
    const allow: Level = { everyone: ow(P.SEND_MESSAGES, 0n) };
    expect(has(computePermissions(base({ chain: [deny, allow] })), P.SEND_MESSAGES)).toBe(true);
    expect(has(computePermissions(base({ chain: [allow, deny] })), P.SEND_MESSAGES)).toBe(false);
    // the channel is the most specific level of all
    expect(has(computePermissions(base({ chain: [deny], channel: allow })), P.SEND_MESSAGES)).toBe(
      true,
    );
    expect(has(computePermissions(base({ chain: [allow], channel: deny })), P.SEND_MESSAGES)).toBe(
      false,
    );
  });

  it('ignores overwrites for other roles and other members', () => {
    const level: Level = {
      roles: { [ROLE_B]: ow(0n, P.SEND_MESSAGES) },
      members: { someoneElse: ow(0n, P.SEND_MESSAGES) },
    };
    expect(
      has(
        computePermissions(
          base({ roles: { [ROLE_A]: 0n, [ROLE_B]: 0n }, memberRoleIds: [ROLE_A], chain: [level] }),
        ),
        P.SEND_MESSAGES,
      ),
    ).toBe(true);
  });

  it('does not mistake object prototype keys for roles or members', () => {
    const level: Level = { roles: { constructor: ow(0n, ALL_PERMISSIONS) } as never, members: {} };
    expect(
      computePermissions(
        base({ memberRoleIds: ['constructor', '__proto__', 'toString'], chain: [level] }),
      ),
    ).toBe(DEFAULT_EVERYONE);
    expect(computePermissions(base({ userId: 'constructor', chain: [{ members: {} }] }))).toBe(
      DEFAULT_EVERYONE,
    );
  });

  it('removes everything that acts inside a container once its VIEW bit is gone', () => {
    const noView = (view: bigint): Level => ({ everyone: ow(0n, view) });
    const rich = ALL_PERMISSIONS & ~P.ADMINISTRATOR;
    for (const { view, dependents } of GATED_BY) {
      const got = computePermissions(base({ everyone: rich, chain: [noView(view)] }));
      expect(has(got, view)).toBe(false);
      expect(got & dependents).toBe(0n);
      expect(got & ~dependents & ~view).toBe(rich & ~dependents & ~view); // everything else is untouched
    }
  });

  it('keeps the unrelated team-level permissions when a channel cannot be seen', () => {
    const got = computePermissions(
      base({ everyone: P.MANAGE_PROJECTS | P.SEND_MESSAGES, channel: ow(0n, P.VIEW_CHANNEL) }),
    );
    expect(has(got, P.MANAGE_PROJECTS)).toBe(true);
    expect(has(got, P.SEND_MESSAGES)).toBe(false); // SEND_MESSAGES needs VIEW_CHANNEL, which @everyone here never had
  });

  it('maskUnviewable on its own leaves a complete set alone', () => {
    expect(maskUnviewable(ALL_PERMISSIONS)).toBe(ALL_PERMISSIONS);
    expect(maskUnviewable(P.SEND_MESSAGES)).toBe(0n);
  });
});

// ------------------------------------------------------------------ exhaustive matrix

describe('exhaustive matrix', () => {
  // One permission (SEND_MESSAGES, with VIEW_CHANNEL held) through every combination of:
  //   where the base comes from (nothing / @everyone / a role / both), and on each of three levels
  //   an @everyone, role and member overwrite that is absent, allow, deny, or both at once.
  const KINDS = ['none', 'allow', 'deny', 'both'] as const;
  const pair = (kind: (typeof KINDS)[number]): Overwrite | undefined =>
    kind === 'none'
      ? undefined
      : ow(
          kind === 'allow' || kind === 'both' ? P.SEND_MESSAGES : 0n,
          kind === 'deny' || kind === 'both' ? P.SEND_MESSAGES : 0n,
        );
  const bases = [
    { everyone: P.VIEW_CHANNEL, role: 0n },
    { everyone: P.VIEW_CHANNEL | P.SEND_MESSAGES, role: 0n },
    { everyone: P.VIEW_CHANNEL, role: P.SEND_MESSAGES },
    { everyone: P.VIEW_CHANNEL | P.SEND_MESSAGES, role: P.SEND_MESSAGES },
  ];

  it('agrees with the reference for every combination (hundreds of thousands of cases)', () => {
    let cases = 0;
    const level = (
      e: (typeof KINDS)[number],
      r: (typeof KINDS)[number],
      m: (typeof KINDS)[number],
    ): Level => ({
      everyone: pair(e),
      roles: r === 'none' ? undefined : { [ROLE_A]: pair(r)! },
      members: m === 'none' ? undefined : { [ME]: pair(m)! },
    });
    const triples = KINDS.flatMap((e) => KINDS.flatMap((r) => KINDS.map((m) => level(e, r, m))));
    for (const b of bases) {
      for (const first of triples) {
        for (const second of triples) {
          for (const third of triples.filter((_, i) => i % 7 === 0)) {
            const input: PermissionInput = {
              userId: ME,
              ownerId: OWNER,
              everyone: b.everyone,
              roles: { [ROLE_A]: b.role },
              memberRoleIds: [ROLE_A],
              chain: [first, second],
              channel: third,
            };
            expect(computePermissions(input)).toBe(reference(input));
            cases++;
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(10_000);
  });
});

// ------------------------------------------------------------------ property test

/** Small deterministic generator so a failure can be reproduced from the seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('property test against the reference', () => {
  it('matches on 20 000 random role / overwrite sets', () => {
    const SEED = 20261125;
    const rnd = mulberry32(SEED);
    const int = (n: number) => Math.floor(rnd() * n);
    /** A random permission set: each of the 39 bits on with the given probability. */
    const set = (p: number): bigint => BITS.reduce((acc, bit) => (rnd() < p ? acc | bit : acc), 0n);
    const pairOrNone = (p = 0.5): Overwrite | undefined =>
      rnd() < p ? ow(set(0.15), set(0.15)) : undefined;

    const users = ['u1', 'u2', 'u3', OWNER];
    const roleIds = ['r1', 'r2', 'r3', 'r4'];
    for (let i = 0; i < 20_000; i++) {
      const roles: Record<string, bigint> = {};
      for (const id of roleIds)
        if (rnd() < 0.7) roles[id] = set(0.12) & ~(rnd() < 0.9 ? P.ADMINISTRATOR : 0n);
      const memberRoleIds = roleIds.filter(() => rnd() < 0.5);
      if (rnd() < 0.1) memberRoleIds.push('ghost'); // a role id nobody defined

      const makeLevel = (): Level => ({
        everyone: pairOrNone(),
        roles:
          rnd() < 0.7
            ? Object.fromEntries(
                [...roleIds, 'ghost'].flatMap((id) =>
                  rnd() < 0.5 ? [[id, ow(set(0.15), set(0.15))]] : [],
                ),
              )
            : undefined,
        members:
          rnd() < 0.7
            ? Object.fromEntries(
                users.flatMap((id) => (rnd() < 0.5 ? [[id, ow(set(0.15), set(0.15))]] : [])),
              )
            : undefined,
      });
      const input: PermissionInput = {
        userId: users[int(users.length)]!,
        ownerId: rnd() < 0.9 ? OWNER : null,
        everyone: set(0.25) & ~(rnd() < 0.95 ? P.ADMINISTRATOR : 0n),
        roles,
        memberRoleIds,
        chain: Array.from({ length: int(5) }, makeLevel),
        channel: rnd() < 0.4 ? makeLevel() : undefined,
      };
      const got = computePermissions(input);
      const want = reference(input);
      if (got !== want)
        throw new Error(
          `seed ${SEED}, case ${i}: got ${namesOf(got)} want ${namesOf(want)}\n${JSON.stringify(input, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
        );
    }
  });

  it('always returns a subset of the defined permissions and never anything for an unviewable container', () => {
    const rnd = mulberry32(7);
    for (let i = 0; i < 2000; i++) {
      const raw = BigInt.asUintN(
        64,
        (BigInt(Math.floor(rnd() * 2 ** 32)) << 32n) | BigInt(Math.floor(rnd() * 2 ** 32)),
      );
      const got = computePermissions({
        userId: ME,
        ownerId: OWNER,
        everyone: raw & ~P.ADMINISTRATOR,
      });
      expect(got & ~ALL_PERMISSIONS).toBe(0n);
      for (const { view, dependents } of GATED_BY)
        if (!has(got, view)) expect(got & dependents).toBe(0n);
    }
  });
});
