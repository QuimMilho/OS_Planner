import { Permission } from './bits';

/** What a person may do in a notebook that was shared with them (the owner's permissions are all of them). */
export const SHARE_READ_PERMISSIONS: bigint = Permission.VIEW_NOTEBOOKS;
export const SHARE_EDIT_PERMISSIONS: bigint =
  Permission.VIEW_NOTEBOOKS | Permission.EDIT_PAGES | Permission.DELETE_PAGES;

export const permissionsForShare = (access: 'read' | 'edit'): bigint =>
  access === 'edit' ? SHARE_EDIT_PERMISSIONS : SHARE_READ_PERMISSIONS;
