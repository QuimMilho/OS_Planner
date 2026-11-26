import { Permission, type PermissionName } from './bits';

/** How the permission grid is laid out (overview §2.3). Every permission is in exactly one group. */
export const PERMISSION_GROUPS: ReadonlyArray<{
  id: string;
  permissions: readonly PermissionName[];
}> = [
  {
    id: 'general',
    permissions: [
      'ADMINISTRATOR',
      'MANAGE_TEAM',
      'MANAGE_ROLES',
      'MANAGE_MEMBERS',
      'CREATE_INVITES',
      'VIEW_AUDIT_LOG',
      'MANAGE_PROJECTS',
    ],
  },
  {
    id: 'chat',
    permissions: [
      'VIEW_CHANNEL',
      'SEND_MESSAGES',
      'READ_MESSAGE_HISTORY',
      'ATTACH_FILES',
      'ADD_REACTIONS',
      'CREATE_THREADS',
      'SEND_IN_THREADS',
      'MENTION_EVERYONE',
      'MANAGE_MESSAGES',
      'MANAGE_CHANNELS',
    ],
  },
  {
    id: 'notebooks',
    permissions: [
      'VIEW_NOTEBOOKS',
      'CREATE_NOTEBOOKS',
      'EDIT_PAGES',
      'DELETE_PAGES',
      'MANAGE_NOTEBOOKS',
      'SHARE_NOTEBOOKS',
    ],
  },
  {
    id: 'boards',
    permissions: [
      'VIEW_BOARDS',
      'CREATE_TASKS',
      'EDIT_TASKS',
      'ASSIGN_TASKS',
      'MANAGE_BOARDS',
      'MANAGE_LABELS',
    ],
  },
  {
    id: 'calendar',
    permissions: ['VIEW_CALENDAR', 'CREATE_MEETINGS', 'MANAGE_MEETINGS', 'ADD_TO_MEMBER_CALENDARS'],
  },
  {
    id: 'voice',
    permissions: ['CONNECT', 'SPEAK', 'VIDEO', 'SCREEN_SHARE', 'MUTE_MEMBERS', 'MOVE_MEMBERS'],
  },
];

/** The "can look inside" bits. A project whose members have none of them is invisible to them. */
export const VIEW_PERMISSIONS: bigint =
  Permission.VIEW_CHANNEL |
  Permission.VIEW_NOTEBOOKS |
  Permission.VIEW_BOARDS |
  Permission.VIEW_CALENDAR;

/** Whether a set lets its holder see into a project at all. */
export const canViewAnything = (set: bigint): boolean => (set & VIEW_PERMISSIONS) !== 0n;
