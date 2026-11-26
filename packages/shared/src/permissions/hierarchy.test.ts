import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, PERMISSION_NAMES, Permission } from './bits';
import { PERMISSION_GROUPS, VIEW_PERMISSIONS, canViewAnything } from './groups';
import {
  checkReorder,
  checkRoleAction,
  positionsForOrder,
  rankOf,
  type RoleAction,
  type RoleActor,
  type RoleDenial,
  type RoleTarget,
} from './hierarchy';

const P = Permission;
const MID_PERMS = P.MANAGE_ROLES | P.VIEW_NOTEBOOKS | P.EDIT_PAGES | P.VIEW_CHANNEL;

// Who is asking. Ranks: the owner is above everything; the administrator's best role is at 10.
const ACTORS: Record<string, RoleActor> = {
  owner: { isOwner: true, perms: ALL_PERMISSIONS, rank: Number.POSITIVE_INFINITY },
  admin: { isOwner: false, perms: ALL_PERMISSIONS, rank: 10 },
  mid: { isOwner: false, perms: MID_PERMS, rank: 5 },
  lowest: { isOwner: false, perms: P.MANAGE_ROLES | P.VIEW_NOTEBOOKS, rank: 1 },
  nobody: { isOwner: false, perms: P.VIEW_NOTEBOOKS | P.EDIT_PAGES, rank: 3 },
};

// What is being touched: a role at each position, and @everyone.
const role = (position: number, permissions = P.VIEW_NOTEBOOKS): RoleTarget => ({
  position,
  isEveryone: false,
  permissions,
});
const TARGETS: Record<string, RoleTarget> = {
  top: role(10),
  sameAsMid: role(5),
  belowMid: role(3),
  bottom: role(1),
  everyone: { position: 0, isEveryone: true, permissions: P.VIEW_NOTEBOOKS },
};

/** The reference table, written out by hand from the rules: [actor][target] -> the answer for edit/assign/unassign. */
const OK = null;
const ABOVE: RoleDenial = 'role_at_or_above';
const NO_MANAGE: RoleDenial = 'missing_manage_roles';
const TABLE: Record<string, Record<string, RoleDenial | null>> = {
  owner: { top: OK, sameAsMid: OK, belowMid: OK, bottom: OK, everyone: OK },
  admin: { top: ABOVE, sameAsMid: OK, belowMid: OK, bottom: OK, everyone: OK },
  mid: { top: ABOVE, sameAsMid: ABOVE, belowMid: OK, bottom: OK, everyone: OK },
  lowest: { top: ABOVE, sameAsMid: ABOVE, belowMid: ABOVE, bottom: ABOVE, everyone: OK },
  nobody: {
    top: NO_MANAGE,
    sameAsMid: NO_MANAGE,
    belowMid: NO_MANAGE,
    bottom: NO_MANAGE,
    everyone: NO_MANAGE,
  },
};

describe('role hierarchy: who may edit, assign or unassign which role', () => {
  for (const action of ['edit', 'assign', 'unassign'] as const satisfies RoleAction[]) {
    for (const [actorName, actor] of Object.entries(ACTORS)) {
      for (const [targetName, target] of Object.entries(TARGETS)) {
        it(`${actorName} ${action} ${targetName}`, () => {
          expect(checkRoleAction(actor, action, target)).toBe(TABLE[actorName]![targetName]);
        });
      }
    }
  }
});

describe('role hierarchy: delete', () => {
  const DELETE: Record<string, Record<string, RoleDenial | null>> = {
    owner: { top: OK, sameAsMid: OK, belowMid: OK, bottom: OK, everyone: 'everyone_protected' },
    admin: { top: ABOVE, sameAsMid: OK, belowMid: OK, bottom: OK, everyone: 'everyone_protected' },
    mid: { top: ABOVE, sameAsMid: ABOVE, belowMid: OK, bottom: OK, everyone: 'everyone_protected' },
    lowest: {
      top: ABOVE,
      sameAsMid: ABOVE,
      belowMid: ABOVE,
      bottom: ABOVE,
      everyone: 'everyone_protected',
    },
    nobody: {
      top: NO_MANAGE,
      sameAsMid: NO_MANAGE,
      belowMid: NO_MANAGE,
      bottom: NO_MANAGE,
      everyone: 'everyone_protected',
    },
  };
  for (const [actorName, actor] of Object.entries(ACTORS))
    for (const [targetName, target] of Object.entries(TARGETS))
      it(`${actorName} delete ${targetName}`, () => {
        expect(checkRoleAction(actor, 'delete', target)).toBe(DELETE[actorName]![targetName]);
      });
});

describe('role hierarchy: creating roles and changing permissions', () => {
  it('creating needs MANAGE_ROLES and only permissions the creator holds', () => {
    expect(checkRoleAction(ACTORS.nobody!, 'create', null, P.VIEW_NOTEBOOKS)).toBe(
      'missing_manage_roles',
    );
    expect(checkRoleAction(ACTORS.mid!, 'create', null, P.EDIT_PAGES)).toBeNull();
    expect(checkRoleAction(ACTORS.mid!, 'create', null, P.EDIT_PAGES | P.EDIT_TASKS)).toBe(
      'permission_not_held',
    );
    expect(checkRoleAction(ACTORS.mid!, 'create', null, P.MANAGE_TEAM)).toBe('permission_not_held');
    expect(checkRoleAction(ACTORS.mid!, 'create', null, 0n)).toBeNull();
    expect(checkRoleAction(ACTORS.admin!, 'create', null, ALL_PERMISSIONS)).toBeNull();
    expect(checkRoleAction(ACTORS.owner!, 'create', null, ALL_PERMISSIONS)).toBeNull();
  });

  it('editing may add or remove only permissions the editor holds', () => {
    const target = role(3, P.VIEW_NOTEBOOKS | P.EDIT_TASKS); // EDIT_TASKS is not held by "mid"
    expect(
      checkRoleAction(ACTORS.mid!, 'edit', target, P.VIEW_NOTEBOOKS | P.EDIT_TASKS | P.EDIT_PAGES),
    ).toBeNull(); // adds a held one
    expect(checkRoleAction(ACTORS.mid!, 'edit', target, P.VIEW_NOTEBOOKS)).toBe(
      'permission_not_held',
    ); // removes EDIT_TASKS, not held
    expect(
      checkRoleAction(
        ACTORS.mid!,
        'edit',
        target,
        P.VIEW_NOTEBOOKS | P.EDIT_TASKS | P.DELETE_PAGES,
      ),
    ).toBe('permission_not_held');
    expect(checkRoleAction(ACTORS.mid!, 'edit', target, target.permissions)).toBeNull(); // nothing changes
    expect(checkRoleAction(ACTORS.owner!, 'edit', target, ALL_PERMISSIONS)).toBeNull();
  });

  it('an edit of a role at or above the editor fails first, whatever it asks for', () => {
    expect(checkRoleAction(ACTORS.mid!, 'edit', TARGETS.sameAsMid!, P.VIEW_NOTEBOOKS)).toBe(
      'role_at_or_above',
    );
    expect(checkRoleAction(ACTORS.admin!, 'edit', TARGETS.top!, P.VIEW_NOTEBOOKS)).toBe(
      'role_at_or_above',
    );
  });

  it('only the owner gives @everyone ADMINISTRATOR, even an administrator may not', () => {
    const everyone = TARGETS.everyone!;
    const withAdmin = everyone.permissions | P.ADMINISTRATOR;
    expect(checkRoleAction(ACTORS.owner!, 'edit', everyone, withAdmin)).toBeNull();
    expect(checkRoleAction(ACTORS.admin!, 'edit', everyone, withAdmin)).toBe(
      'administrator_owner_only',
    );
    expect(checkRoleAction(ACTORS.mid!, 'edit', everyone, withAdmin)).toBe(
      'administrator_owner_only',
    );
    // other permissions on @everyone follow the usual rules
    expect(
      checkRoleAction(ACTORS.mid!, 'edit', everyone, everyone.permissions | P.EDIT_PAGES),
    ).toBeNull();
    expect(
      checkRoleAction(ACTORS.mid!, 'edit', everyone, everyone.permissions | P.EDIT_TASKS),
    ).toBe('permission_not_held');
    // taking ADMINISTRATOR away from @everyone is allowed for whoever holds it
    const admins = { ...everyone, permissions: everyone.permissions | P.ADMINISTRATOR };
    expect(checkRoleAction(ACTORS.admin!, 'edit', admins, everyone.permissions)).toBeNull();
  });
});

describe('role hierarchy: reordering', () => {
  const current = [
    { id: 'a', position: 4 },
    { id: 'b', position: 3 },
    { id: 'c', position: 2 },
    { id: 'd', position: 1 },
  ];
  const rank3: RoleActor = { isOwner: false, perms: P.MANAGE_ROLES, rank: 3 };

  it('refuses a list that is not exactly the roles of the scope', () => {
    expect(checkReorder(ACTORS.owner!, current, ['a', 'b', 'c'])).toBe('invalid_order');
    expect(checkReorder(ACTORS.owner!, current, ['a', 'b', 'c', 'x'])).toBe('invalid_order');
    expect(checkReorder(ACTORS.owner!, current, ['a', 'a', 'b', 'c'])).toBe('invalid_order');
  });
  it('the owner may reorder anything', () => {
    expect(checkReorder(ACTORS.owner!, current, ['d', 'c', 'b', 'a'])).toBeNull();
  });
  it('someone at rank 3 may reorder what is below but not the roles at or above, nor move one up into them', () => {
    expect(checkReorder(rank3, current, ['a', 'b', 'd', 'c'])).toBeNull(); // only c and d swap
    expect(checkReorder(rank3, current, ['b', 'a', 'c', 'd'])).toBe('role_at_or_above'); // swaps a and b
    expect(checkReorder(rank3, current, ['d', 'a', 'b', 'c'])).toBe('role_at_or_above'); // d jumps to the top
    expect(checkReorder(rank3, current, ['a', 'd', 'b', 'c'])).toBe('role_at_or_above'); // d moves above b (rank)
  });
  it('needs MANAGE_ROLES', () => {
    expect(checkReorder(ACTORS.nobody!, current, ['a', 'b', 'c', 'd'])).toBe(
      'missing_manage_roles',
    );
  });
  it('positions run from n (first) down to 1 (last)', () => {
    expect([...positionsForOrder(['x', 'y', 'z'])]).toEqual([
      ['x', 3],
      ['y', 2],
      ['z', 1],
    ]);
  });
  it('a rank is the highest position held, 0 for nobody', () => {
    expect(rankOf([])).toBe(0);
    expect(rankOf([2, 7, 3])).toBe(7);
  });
});

describe('permission groups', () => {
  it('list every permission exactly once', () => {
    const listed = PERMISSION_GROUPS.flatMap((g) => g.permissions);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...PERMISSION_NAMES].sort());
  });
  it('the view bits are the four VIEW_ permissions', () => {
    expect(VIEW_PERMISSIONS).toBe(
      P.VIEW_CHANNEL | P.VIEW_NOTEBOOKS | P.VIEW_BOARDS | P.VIEW_CALENDAR,
    );
    expect(canViewAnything(P.VIEW_BOARDS)).toBe(true);
    expect(canViewAnything(P.EDIT_PAGES | P.MANAGE_ROLES)).toBe(false);
  });
});
