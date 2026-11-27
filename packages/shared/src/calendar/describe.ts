import { parseRRule, WEEKDAYS, type RRule } from './rrule';

/** A translator: `rrule.*` keys (en and pt in the web app's dictionaries), with `{name}` placeholders. */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** What the repeat picker offers first; anything else is "custom". */
export const REPEAT_PRESETS = [
  'none',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'yearly',
  'custom',
] as const;
export type RepeatPreset = (typeof REPEAT_PRESETS)[number];

/** Which preset an RRULE text is, given the weekday and day of month of the event's start. */
export function presetOf(rrule: string | null, startDow: number, startDay: number): RepeatPreset {
  if (!rrule) return 'none';
  const p = parseRRule(rrule);
  if (!p.ok) return 'custom';
  const r = p.rule;
  const plain =
    r.interval === 1 &&
    r.count === undefined &&
    r.until === undefined &&
    !r.byMonth &&
    !r.bySetPos &&
    !r.byMonthDay?.length;
  if (!plain) return 'custom';
  const days = r.byDay;
  if (r.freq === 'DAILY' && !days) return 'daily';
  if (
    r.freq === 'WEEKLY' &&
    days?.length === 5 &&
    [1, 2, 3, 4, 5].every((d) => days.some((x) => x.day === d && x.ord === undefined))
  )
    return 'weekdays';
  if (
    r.freq === 'WEEKLY' &&
    (!days || (days.length === 1 && days[0]!.day === startDow && days[0]!.ord === undefined))
  )
    return 'weekly';
  if (
    r.freq === 'MONTHLY' &&
    !days &&
    (!r.byMonthDay || (r.byMonthDay.length === 1 && r.byMonthDay[0] === startDay))
  )
    return 'monthly';
  if (r.freq === 'YEARLY' && !days) return 'yearly';
  return 'custom';
}

/** The rule text of a preset for an event that starts on this weekday (0 Sunday) and day of the month. */
export function ruleOfPreset(preset: RepeatPreset, startDow: number): string | null {
  switch (preset) {
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekdays':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${WEEKDAYS[startDow]}`;
    case 'monthly':
      return 'FREQ=MONTHLY';
    case 'yearly':
      return 'FREQ=YEARLY';
    default:
      return null;
  }
}

const unit = (freq: RRule['freq']) =>
  ({ DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' })[freq];

/**
 * A rule in plain language ("Every 2 weeks on Monday and Wednesday, 10 times"), assembled from `rrule.*` pieces so each language
 * reads naturally. `formatDate` writes the UNTIL date in the person's language.
 */
export function describeRRule(
  rrule: string,
  t: Translate,
  formatDate: (ms: number) => string,
): string {
  const parsed = parseRRule(rrule);
  if (!parsed.ok) return rrule;
  const r = parsed.rule;
  const names = (days: number[]) =>
    list(
      days.map((d) => t(`rrule.day.${WEEKDAYS[d]}`)),
      t,
    );
  const parts: string[] = [
    r.interval === 1
      ? t(`rrule.every.${unit(r.freq)}`)
      : t(`rrule.everyN.${unit(r.freq)}`, { n: r.interval }),
  ];

  if (r.byDay?.length) {
    const plain = r.byDay.filter((b) => b.ord === undefined).map((b) => b.day);
    const nth = r.byDay.filter((b) => b.ord !== undefined);
    const bits: string[] = [];
    if (plain.length) bits.push(t('rrule.onDays', { days: names(plain) }));
    for (const b of nth)
      bits.push(
        t('rrule.onNth', { nth: t(`rrule.nth.${b.ord}`), day: t(`rrule.day.${WEEKDAYS[b.day]}`) }),
      );
    parts.push(list(bits, t));
  }
  if (r.byMonthDay?.length)
    parts.push(
      t('rrule.onMonthDays', {
        days: list(
          r.byMonthDay.map((n) => (n < 0 ? t('rrule.lastDay', { n: -n }) : String(n))),
          t,
        ),
      }),
    );
  if (r.byMonth?.length)
    parts.push(
      t('rrule.inMonths', {
        months: list(
          r.byMonth.map((m) => t(`rrule.month.${m}`)),
          t,
        ),
      }),
    );
  if (r.count !== undefined) parts.push(t('rrule.times', { n: r.count }));
  if (r.until !== undefined) parts.push(t('rrule.until', { date: formatDate(r.until) }));
  return parts.join(', ');
}

function list(items: string[], t: Translate): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} ${t('rrule.and')} ${items.at(-1)}`;
}
