import { Permission } from './bits';

/** What a person may publish in a voice channel, from their effective permissions there. Subscribing is always allowed. */
export interface VoiceGrants {
  /** `CONNECT`: may be in the room at all. */
  connect: boolean;
  /** `SPEAK`: may publish the microphone. Without it the person joins muted and cannot unmute. */
  speak: boolean;
  /** `VIDEO`: may publish the camera. */
  video: boolean;
  /** `SCREEN_SHARE`: may share the screen. */
  screen: boolean;
}

export const voiceGrants = (perms: bigint): VoiceGrants => ({
  connect: (perms & Permission.CONNECT) !== 0n,
  speak: (perms & Permission.SPEAK) !== 0n,
  video: (perms & Permission.VIDEO) !== 0n,
  screen: (perms & Permission.SCREEN_SHARE) !== 0n,
});

/** LiveKit's names of the track sources a grant allows (`canPublishSources` of an access token). */
export type VoiceSource = 'microphone' | 'camera' | 'screen_share' | 'screen_share_audio';

export function publishSources(grants: VoiceGrants, mutedByModerator = false): VoiceSource[] {
  const out: VoiceSource[] = [];
  if (grants.speak && !mutedByModerator) out.push('microphone');
  if (grants.video) out.push('camera');
  if (grants.screen) out.push('screen_share', 'screen_share_audio');
  return out;
}

export type ModerationAction = 'mute' | 'unmute' | 'move' | 'disconnect';

/** Why a moderator action is refused. Always a 403. */
export type ModerationDenial =
  'missing_permission' | 'target_is_owner' | 'target_at_or_above' | 'target_is_self';

export interface ModerationParty {
  isOwner: boolean;
  /** Permissions in the channel (an owner or administrator holds every bit). */
  perms: bigint;
  /** Highest role position that applies (0 = only @everyone). Compared only between two people of one team. */
  rank: number;
}

/**
 * Who may mute, move or disconnect whom. Pure, so the server and the web (which hides what would be refused) agree.
 *  - mute/unmute need `MUTE_MEMBERS`, move needs `MOVE_MEMBERS`, disconnect needs `MOVE_MEMBERS` or `MANAGE_CHANNELS`.
 *  - nobody moderates the owner, nor themselves;
 *  - the owner moderates everybody else; anybody else only people whose highest role is strictly lower than theirs, and
 *    only an administrator moderates an administrator.
 */
export function checkModeration(
  actor: ModerationParty,
  action: ModerationAction,
  target: ModerationParty,
  sameUser = false,
): ModerationDenial | null {
  const allowed =
    actor.isOwner ||
    (actor.perms & Permission.ADMINISTRATOR) !== 0n ||
    (action === 'mute' || action === 'unmute'
      ? (actor.perms & Permission.MUTE_MEMBERS) !== 0n
      : action === 'move'
        ? (actor.perms & Permission.MOVE_MEMBERS) !== 0n
        : (actor.perms & (Permission.MOVE_MEMBERS | Permission.MANAGE_CHANNELS)) !== 0n);
  if (!allowed) return 'missing_permission';
  if (sameUser) return 'target_is_self';
  if (target.isOwner) return 'target_is_owner';
  if (actor.isOwner) return null;
  if (
    (target.perms & Permission.ADMINISTRATOR) !== 0n &&
    (actor.perms & Permission.ADMINISTRATOR) === 0n
  )
    return 'target_at_or_above';
  if (target.rank >= actor.rank) return 'target_at_or_above';
  return null;
}
