import { describe, expect, it } from 'vitest';
import { isSharedCursorKey, notebookOfSharedKey, sharedCursorKey } from '../dto/shared-keys';
import {
  createLinkSchema,
  putShareSchema,
  resolveLinkSchema,
  syncChangesQuerySchema,
  updateLinkSchema,
} from '../index';
import { computePermissions } from './compute';
import { Permission } from './bits';
import { permissionsForShare, SHARE_EDIT_PERMISSIONS, SHARE_READ_PERMISSIONS } from './share';

const P = Permission;
const has = (set: bigint, bit: bigint) => (set & bit) === bit;

describe('what a share allows', () => {
  it('read only looks; edit also writes and deletes pages, nothing that manages or shares', () => {
    expect(permissionsForShare('read')).toBe(SHARE_READ_PERMISSIONS);
    expect(permissionsForShare('edit')).toBe(SHARE_EDIT_PERMISSIONS);
    expect(has(SHARE_READ_PERMISSIONS, P.VIEW_NOTEBOOKS)).toBe(true);
    for (const bit of [
      P.EDIT_PAGES,
      P.DELETE_PAGES,
      P.CREATE_NOTEBOOKS,
      P.MANAGE_NOTEBOOKS,
      P.SHARE_NOTEBOOKS,
    ])
      expect(has(SHARE_READ_PERMISSIONS, bit)).toBe(false);
    for (const bit of [P.VIEW_NOTEBOOKS, P.EDIT_PAGES, P.DELETE_PAGES])
      expect(has(SHARE_EDIT_PERMISSIONS, bit)).toBe(true);
    for (const bit of [P.CREATE_NOTEBOOKS, P.MANAGE_NOTEBOOKS, P.SHARE_NOTEBOOKS, P.ADMINISTRATOR])
      expect(has(SHARE_EDIT_PERMISSIONS, bit)).toBe(false);
  });
});

describe('a notebook overwrite is one more level of the chain', () => {
  const base = { userId: 'u', ownerId: null, everyone: P.VIEW_NOTEBOOKS | P.EDIT_PAGES };

  it('denying VIEW_NOTEBOOKS takes every notebook right with it', () => {
    const level = { ref: 'nb', members: { u: { allow: 0n, deny: P.VIEW_NOTEBOOKS } } };
    const perms = computePermissions({ ...base, chain: [level] });
    expect(has(perms, P.VIEW_NOTEBOOKS)).toBe(false);
    expect(has(perms, P.EDIT_PAGES)).toBe(false);
  });

  it('allowing EDIT_PAGES for @everyone on the notebook lifts only that notebook', () => {
    const view = P.VIEW_NOTEBOOKS;
    const plain = computePermissions({ userId: 'u', ownerId: null, everyone: view });
    const lifted = computePermissions({
      userId: 'u',
      ownerId: null,
      everyone: view,
      chain: [{ ref: 'nb', everyone: { allow: P.EDIT_PAGES, deny: 0n } }],
    });
    expect(has(plain, P.EDIT_PAGES)).toBe(false);
    expect(has(lifted, P.EDIT_PAGES)).toBe(true);
  });

  it('a member allow on the notebook beats a role deny on the same notebook', () => {
    const input = {
      ...base,
      roles: { r: P.VIEW_NOTEBOOKS },
      memberRoleIds: ['r'],
      chain: [
        {
          ref: 'nb',
          roles: { r: { allow: 0n, deny: P.EDIT_PAGES } },
          members: { u: { allow: P.EDIT_PAGES, deny: 0n } },
        },
      ],
    };
    expect(has(computePermissions(input), P.EDIT_PAGES)).toBe(true);
  });
});

describe('cursor keys of shared notebooks', () => {
  it('round-trip and are told apart from space ids', () => {
    const id = '0198a2b4-0000-7000-8000-000000000001';
    expect(sharedCursorKey(id)).toBe(`shared:${id}`);
    expect(isSharedCursorKey(sharedCursorKey(id))).toBe(true);
    expect(isSharedCursorKey(id)).toBe(false);
    expect(notebookOfSharedKey(sharedCursorKey(id))).toBe(id);
  });

  it('the sync query accepts them next to space ids, and nothing else', () => {
    const id = '0198a2b4-0000-7000-8000-000000000001';
    const ok = syncChangesQuerySchema.safeParse({
      cursors: JSON.stringify({ [id]: 3, [`shared:${id}`]: 0 }),
    });
    expect(ok.success).toBe(true);
    for (const key of ['shared:nope', 'other:' + id, 'x'])
      expect(
        syncChangesQuerySchema.safeParse({ cursors: JSON.stringify({ [key]: 1 }) }).success,
      ).toBe(false);
  });
});

describe('sharing request bodies', () => {
  const id = '0198a2b4-0000-7000-8000-000000000001';

  it('a share names a person or an address, never both or neither', () => {
    expect(putShareSchema.safeParse({ userId: id, access: 'read' }).success).toBe(true);
    expect(putShareSchema.safeParse({ email: 'a@example.com', access: 'edit' }).success).toBe(true);
    expect(putShareSchema.safeParse({ access: 'edit' }).success).toBe(false);
    expect(
      putShareSchema.safeParse({ userId: id, email: 'a@example.com', access: 'edit' }).success,
    ).toBe(false);
    expect(putShareSchema.safeParse({ userId: id, access: 'owner' }).success).toBe(false);
  });

  it('links: bounded expiry, password length, access', () => {
    expect(createLinkSchema.safeParse({ access: 'read' }).success).toBe(true);
    expect(
      createLinkSchema.safeParse({ access: 'edit', expiresInDays: 365, password: 'abcd' }).success,
    ).toBe(true);
    for (const bad of [
      { access: 'read', expiresInDays: 0 },
      { access: 'read', expiresInDays: 366 },
      { access: 'read', password: 'abc' },
      { access: 'admin' },
    ])
      expect(createLinkSchema.safeParse(bad).success).toBe(false);
    expect(updateLinkSchema.safeParse({ password: null, expiresInDays: null }).success).toBe(true);
  });

  it('a token is URL-safe and long enough; anything else is refused before it reaches the database', () => {
    expect(resolveLinkSchema.safeParse({ token: 'A'.repeat(43) }).success).toBe(true);
    for (const token of [
      'short',
      'has space ' + 'A'.repeat(30),
      '../' + 'A'.repeat(40),
      'A'.repeat(101),
    ])
      expect(resolveLinkSchema.safeParse({ token }).success).toBe(false);
  });
});
