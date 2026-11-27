import { describe, expect, it } from 'vitest';
import { Permission as P } from './bits';
import { checkModeration, publishSources, voiceGrants, type ModerationParty } from './voice';

const party = (perms: bigint, rank = 1, isOwner = false): ModerationParty => ({
  isOwner,
  perms,
  rank,
});

describe('voiceGrants / publishSources', () => {
  it('maps each bit to one grant', () => {
    expect(voiceGrants(0n)).toEqual({ connect: false, speak: false, video: false, screen: false });
    expect(voiceGrants(P.CONNECT)).toEqual({
      connect: true,
      speak: false,
      video: false,
      screen: false,
    });
    expect(voiceGrants(P.CONNECT | P.SPEAK | P.VIDEO | P.SCREEN_SHARE)).toEqual({
      connect: true,
      speak: true,
      video: true,
      screen: true,
    });
  });

  it('lists exactly the sources the grants allow, and drops the microphone while a moderator keeps it off', () => {
    const all = voiceGrants(P.CONNECT | P.SPEAK | P.VIDEO | P.SCREEN_SHARE);
    expect(publishSources(all)).toEqual([
      'microphone',
      'camera',
      'screen_share',
      'screen_share_audio',
    ]);
    expect(publishSources(all, true)).toEqual(['camera', 'screen_share', 'screen_share_audio']);
    expect(publishSources(voiceGrants(P.CONNECT))).toEqual([]);
    expect(publishSources(voiceGrants(P.CONNECT | P.SCREEN_SHARE))).toEqual([
      'screen_share',
      'screen_share_audio',
    ]);
  });
});

describe('checkModeration', () => {
  it('needs the permission of the action', () => {
    expect(checkModeration(party(0n), 'mute', party(0n, 0))).toBe('missing_permission');
    expect(checkModeration(party(P.MUTE_MEMBERS), 'mute', party(0n, 0))).toBeNull();
    expect(checkModeration(party(P.MUTE_MEMBERS), 'unmute', party(0n, 0))).toBeNull();
    expect(checkModeration(party(P.MUTE_MEMBERS), 'move', party(0n, 0))).toBe('missing_permission');
    expect(checkModeration(party(P.MOVE_MEMBERS), 'move', party(0n, 0))).toBeNull();
    expect(checkModeration(party(P.MOVE_MEMBERS), 'disconnect', party(0n, 0))).toBeNull();
    expect(checkModeration(party(P.MANAGE_CHANNELS), 'disconnect', party(0n, 0))).toBeNull();
    expect(checkModeration(party(P.MUTE_MEMBERS), 'disconnect', party(0n, 0))).toBe(
      'missing_permission',
    );
  });

  it('never touches the owner or oneself, and only people ranked below', () => {
    const mod = party(P.MUTE_MEMBERS, 5);
    expect(checkModeration(mod, 'mute', party(0n, 0, true))).toBe('target_is_owner');
    expect(checkModeration(mod, 'mute', party(0n, 5))).toBe('target_at_or_above');
    expect(checkModeration(mod, 'mute', party(0n, 6))).toBe('target_at_or_above');
    expect(checkModeration(mod, 'mute', party(0n, 4))).toBeNull();
    expect(checkModeration(mod, 'mute', mod, true)).toBe('target_is_self');
  });

  it('lets the owner moderate everybody else, and only an administrator moderate an administrator', () => {
    const owner = party(P.ADMINISTRATOR, Number.POSITIVE_INFINITY, true);
    expect(checkModeration(owner, 'disconnect', party(P.ADMINISTRATOR, 99))).toBeNull();
    expect(checkModeration(owner, 'disconnect', party(0n, 0, true), true)).toBe('target_is_self');
    expect(checkModeration(party(P.MUTE_MEMBERS, 9), 'mute', party(P.ADMINISTRATOR, 1))).toBe(
      'target_at_or_above',
    );
    expect(
      checkModeration(party(P.ADMINISTRATOR, 9), 'mute', party(P.ADMINISTRATOR, 1)),
    ).toBeNull();
  });
});
