import { describe, expect, it } from 'vitest';
import type { QuietHoursDto } from '../dto/notifications';
import {
  inQuietHours,
  resolveSetting,
  shouldEmail,
  shouldNotify,
  strongest,
  type ResolveDefaults,
  type ScopeRule,
} from './notify';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const HOUR = 3_600_000;

const rule = (scopeKind: ScopeRule['scopeKind'], over: Partial<ScopeRule> = {}): ScopeRule => ({
  scopeKind,
  scopeId: scopeKind === 'global' ? null : `${scopeKind}-id`,
  level: 'inherit',
  suppressEveryone: null,
  suppressRoles: null,
  suppressDirect: null,
  mutedUntil: null,
  email: 'inherit',
  emailOnlyWhenAway: null,
  push: null,
  ...over,
});

const channelDefaults: ResolveDefaults = { level: 'mentions' };
const resolve = (chain: ScopeRule[], now = NOW, defaults = channelDefaults) =>
  resolveSetting(chain, now, defaults);

describe('resolving settings', () => {
  it('uses the defaults when nothing is set: mentions in channels, everything in conversations', () => {
    const e = resolve([]);
    expect(e).toMatchObject({
      level: 'mentions',
      muted: false,
      silenced: false,
      email: 'off',
      push: true,
      emailOnlyWhenAway: true,
    });
    expect(e.sources.level).toEqual({ scopeKind: 'default', scopeId: null });
    expect(resolve([], NOW, { level: 'all' }).level).toBe('all');
  });

  it('takes the level from the nearest scope that says something, and inherit falls through', () => {
    const chain = [
      rule('channel', { level: 'inherit' }),
      rule('project', { level: 'none' }),
      rule('team', { level: 'all' }),
      rule('global', { level: 'mentions' }),
    ];
    expect(resolve(chain).level).toBe('none');
    expect(resolve(chain).sources.level).toEqual({ scopeKind: 'project', scopeId: 'project-id' });
    expect(resolve([rule('channel', { level: 'all' }), ...chain.slice(1)]).level).toBe('all');
    expect(resolve([rule('channel'), rule('project'), rule('team', { level: 'all' })]).level).toBe(
      'all',
    );
    expect(resolve([rule('global', { level: 'all' })]).level).toBe('all');
  });

  it('applies every setting on its own: the level of one scope, the email of another', () => {
    const e = resolve([
      rule('channel', { email: 'all' }),
      rule('team', { level: 'none', email: 'off', push: false }),
      rule('global', { suppressDirect: true }),
    ]);
    expect(e).toMatchObject({ level: 'none', email: 'all', push: false, suppressDirect: true });
    expect(e.sources.email.scopeKind).toBe('channel');
    expect(e.sources.push.scopeKind).toBe('team');
    expect(e.sources.suppressDirect.scopeKind).toBe('global');
  });

  describe('mutes', () => {
    it('silence from the scope that set them downwards, until they end', () => {
      const team = rule('team', { mutedUntil: NOW + HOUR });
      expect(resolve([rule('channel'), team]).muted).toBe(true);
      expect(resolve([rule('channel'), team]).sources.mute.scopeKind).toBe('team');
      expect(resolve([rule('channel'), team], NOW + HOUR).muted).toBe(false); // exactly at the end: over
      expect(resolve([rule('channel'), team], NOW + 2 * HOUR).muted).toBe(false);
      expect(resolve([rule('channel', { mutedUntil: NOW - 1 })]).muted).toBe(false); // already over
      expect(resolve([]).muted).toBe(false);
    });

    it('can be undone below: a channel that sets its own end (even one in the past) decides for itself', () => {
      const team = rule('team', { mutedUntil: NOW + HOUR });
      expect(resolve([rule('channel', { mutedUntil: NOW - 1, level: 'all' }), team])).toMatchObject(
        { muted: false, silenced: false, level: 'all' },
      );
      expect(
        resolve([
          rule('channel', { mutedUntil: NOW + 3 * HOUR }),
          rule('team', { mutedUntil: NOW - HOUR }),
        ]).muted,
      ).toBe(true);
      // a level on its own does not un-mute
      expect(resolve([rule('channel', { level: 'all' }), team])).toMatchObject({
        muted: true,
        silenced: true,
      });
    });

    it('can last until turned back on', () => {
      expect(
        resolve([rule('channel', { mutedUntil: Date.parse('9999-12-31T23:59:59Z') })]).muted,
      ).toBe(true);
    });

    it('count "nothing" as silence too', () => {
      expect(resolve([rule('channel', { level: 'none' })])).toMatchObject({
        muted: false,
        silenced: true,
      });
    });
  });
});

describe('what gets through', () => {
  const open = resolve([]);
  const muted = resolve([rule('channel', { mutedUntil: NOW + HOUR })]);

  it('lets mentions through at the default level and not ordinary messages', () => {
    expect(
      ['direct', 'role', 'everyone', 'here'].map((t) => shouldNotify(open, t as 'direct')),
    ).toEqual([true, true, true, true]);
    expect(shouldNotify(open, 'message')).toBe(false);
    expect(shouldNotify(resolve([rule('global', { level: 'all' })]), 'message')).toBe(true);
  });

  it('silences everything but a direct mention while muted or set to nothing', () => {
    for (const e of [muted, resolve([rule('channel', { level: 'none' })])]) {
      expect(shouldNotify(e, 'direct')).toBe(true);
      expect(shouldNotify(e, 'role')).toBe(false);
      expect(shouldNotify(e, 'everyone')).toBe(false);
      expect(shouldNotify(e, 'here')).toBe(false);
      expect(shouldNotify(e, 'message')).toBe(false);
    }
    // an ended mute silences nothing
    expect(shouldNotify(resolve([rule('channel', { mutedUntil: NOW - 1 })]), 'role')).toBe(true);
  });

  it('lets the person turn off each kind of mention on its own', () => {
    const noEveryone = resolve([rule('channel', { suppressEveryone: true })]);
    expect([
      shouldNotify(noEveryone, 'everyone'),
      shouldNotify(noEveryone, 'here'),
      shouldNotify(noEveryone, 'role'),
      shouldNotify(noEveryone, 'direct'),
    ]).toEqual([false, false, true, true]);
    const noRoles = resolve([rule('channel', { suppressRoles: true })]);
    expect([
      shouldNotify(noRoles, 'role'),
      shouldNotify(noRoles, 'everyone'),
      shouldNotify(noRoles, 'direct'),
    ]).toEqual([false, true, true]);
    // a direct mention is the last thing to go: only its own switch silences it, even in a muted channel
    expect(
      shouldNotify(
        resolve([rule('channel', { suppressDirect: true, mutedUntil: NOW + HOUR })]),
        'direct',
      ),
    ).toBe(false);
    expect(
      shouldNotify(
        resolve([rule('channel', { suppressDirect: false, mutedUntil: NOW + HOUR })]),
        'direct',
      ),
    ).toBe(true);
    // a lower scope can switch it back on
    expect(
      shouldNotify(
        resolve([
          rule('channel', { suppressEveryone: false }),
          rule('team', { suppressEveryone: true }),
        ]),
        'everyone',
      ),
    ).toBe(true);
  });

  it('picks the strongest kind that gets through', () => {
    const noDirect = resolve([rule('channel', { suppressDirect: true })]);
    expect(strongest(open, ['here', 'role', 'direct'])).toBe('direct');
    expect(strongest(open, ['here', 'everyone'])).toBe('everyone');
    expect(strongest(noDirect, ['direct', 'role'])).toBe('role');
    expect(strongest(muted, ['role', 'everyone'])).toBeNull();
    expect(strongest(open, [])).toBeNull();
  });

  it('decides about email on its own option', () => {
    const mail = (email: 'off' | 'mentions' | 'all', over: Partial<ScopeRule> = {}) =>
      resolve([rule('channel', { email, ...over })]);
    expect(shouldEmail(mail('off'), 'direct')).toBe(false);
    expect(shouldEmail(mail('mentions'), 'direct')).toBe(true);
    expect(shouldEmail(mail('mentions'), 'everyone')).toBe(true);
    expect(shouldEmail(mail('mentions'), 'message')).toBe(false);
    expect(shouldEmail(mail('all'), 'message')).toBe(true);
    // a muted chat mails mentions of you and nothing else
    expect(shouldEmail(mail('all', { mutedUntil: NOW + HOUR }), 'message')).toBe(false);
    expect(shouldEmail(mail('all', { mutedUntil: NOW + HOUR }), 'direct')).toBe(true);
    expect(shouldEmail(mail('mentions', { suppressRoles: true }), 'role')).toBe(false);
  });
});

describe('quiet hours', () => {
  const lisbon = (over: Partial<QuietHoursDto> = {}): QuietHoursDto => ({
    enabled: true,
    from: '22:00',
    to: '07:00',
    days: [0, 1, 2, 3, 4, 5, 6],
    timeZone: 'Europe/Lisbon',
    ...over,
  });
  // 2026-11-26 is a Thursday; Lisbon is UTC+0 in November
  const at = (iso: string) => new Date(iso);

  it('hold back the night, including past midnight', () => {
    expect(inQuietHours(lisbon(), at('2026-11-26T23:30:00Z'))).toBe(true);
    expect(inQuietHours(lisbon(), at('2026-11-27T03:00:00Z'))).toBe(true);
    expect(inQuietHours(lisbon(), at('2026-11-27T06:59:00Z'))).toBe(true);
    expect(inQuietHours(lisbon(), at('2026-11-27T07:00:00Z'))).toBe(false);
    expect(inQuietHours(lisbon(), at('2026-11-26T12:00:00Z'))).toBe(false);
    expect(inQuietHours(lisbon(), at('2026-11-26T22:00:00Z'))).toBe(true);
  });

  it('use the local time of the person, not the server', () => {
    // 23:30 in Lisbon is 08:30 the next day in Tokyo
    expect(inQuietHours(lisbon({ timeZone: 'Asia/Tokyo' }), at('2026-11-26T23:30:00Z'))).toBe(
      false,
    );
    expect(inQuietHours(lisbon({ timeZone: 'Asia/Tokyo' }), at('2026-11-26T14:00:00Z'))).toBe(true); // 23:00 there
    expect(inQuietHours(lisbon({ timeZone: 'Not/AZone' }), at('2026-11-26T23:30:00Z'))).toBe(true); // reads as UTC
  });

  it('belong to the day they start on', () => {
    const fridayNights = lisbon({ days: [5] });
    expect(inQuietHours(fridayNights, at('2026-11-27T23:00:00Z'))).toBe(true); // Friday 23:00
    expect(inQuietHours(fridayNights, at('2026-11-28T02:00:00Z'))).toBe(true); // Saturday 02:00: still Friday's night
    expect(inQuietHours(fridayNights, at('2026-11-28T23:00:00Z'))).toBe(false); // Saturday night: not chosen
    expect(inQuietHours(fridayNights, at('2026-11-27T02:00:00Z'))).toBe(false); // Friday 02:00 belongs to Thursday night
  });

  it('handle a window inside one day, and nothing when switched off', () => {
    const lunch = lisbon({ from: '12:00', to: '13:00', days: [4] });
    expect(inQuietHours(lunch, at('2026-11-26T12:30:00Z'))).toBe(true);
    expect(inQuietHours(lunch, at('2026-11-26T13:00:00Z'))).toBe(false);
    expect(inQuietHours(lunch, at('2026-11-27T12:30:00Z'))).toBe(false);
    expect(inQuietHours(lisbon({ enabled: false }), at('2026-11-26T23:30:00Z'))).toBe(false);
    expect(inQuietHours(lisbon({ days: [] }), at('2026-11-26T23:30:00Z'))).toBe(false);
    expect(inQuietHours(lisbon({ from: '08:00', to: '08:00' }), at('2026-11-26T08:00:00Z'))).toBe(
      false,
    );
    expect(inQuietHours(null, at('2026-11-26T23:30:00Z'))).toBe(false);
  });
});
