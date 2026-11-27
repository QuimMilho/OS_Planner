import { RRULE_LIMITS, formatRRule, parseRRule } from '../calendar/rrule';

export interface MappedRule {
  /** The canonical rule this calendar understands, or null (the event is kept as a single one). */
  rrule: string | null;
  /** Something of the original rule was dropped or changed. */
  simplified: boolean;
}

const split = (text: string): Map<string, string> => {
  const parts = new Map<string, string>();
  for (const p of text.replace(/^RRULE:/i, '').split(';')) {
    const eq = p.indexOf('=');
    if (eq > 0) parts.set(p.slice(0, eq).toUpperCase(), p.slice(eq + 1).toUpperCase());
  }
  return parts;
};

const join = (parts: Map<string, string>): string =>
  [...parts].map(([k, v]) => `${k}=${v}`).join(';');

/** Parts that only choose a time inside the day or a day of the year: dropped, the event keeps its own time and the rest of the rule. */
const DROPPABLE = ['BYSECOND', 'BYMINUTE', 'BYHOUR', 'BYWEEKNO', 'BYYEARDAY'];

/**
 * Brings a rule from another calendar into the subset this one evaluates (see `parseRRule`). What is only detail is dropped (times inside
 * the day, ordinals in a weekly rule, a COUNT beyond the limit is cut), and the result says so; a rule that cannot be kept at all (every
 * hour, every minute, nonsense) gives `null`, so the event is shown once instead of never. Always bounded: the output is a rule `parseRRule` accepts.
 */
export function mapRRule(text: string): MappedRule {
  let simplified = false;
  let parts = split(text);
  if (!parts.size || text.length > 2000) return { rrule: null, simplified: true };
  for (let round = 0; round < 12; round++) {
    const parsed = parseRRule(join(parts));
    if (parsed.ok) return { rrule: formatRRule(parsed.rule), simplified };
    const err = parsed.error;
    simplified = true;
    if (err.startsWith('rrule_unsupported:')) {
      const key = err.slice('rrule_unsupported:'.length);
      if (!DROPPABLE.includes(key) && key !== 'RSCALE' && key !== 'SKIP' && key !== 'BYEASTER')
        return { rrule: null, simplified };
      parts.delete(key);
    } else if (err === 'rrule_count') parts.set('COUNT', String(RRULE_LIMITS.count));
    else if (err === 'rrule_interval') parts.set('INTERVAL', String(RRULE_LIMITS.interval));
    else if (err === 'rrule_count_and_until') parts.delete('UNTIL');
    else if (err === 'rrule_bysetpos') parts.delete('BYSETPOS');
    else if (err === 'rrule_bymonthday_weekly') parts.delete('BYMONTHDAY');
    else if (err === 'rrule_byday_ordinal') {
      const by = parts.get('BYDAY') ?? '';
      parts.set(
        'BYDAY',
        by
          .split(',')
          .map((d) => d.replace(/^[+-]?\d+/, ''))
          .join(','),
      );
    } else if (
      err === 'rrule_byday' &&
      (parts.get('BYDAY') ?? '').split(',').length > RRULE_LIMITS.byDay
    ) {
      parts.set(
        'BYDAY',
        (parts.get('BYDAY') ?? '').split(',').slice(0, RRULE_LIMITS.byDay).join(','),
      );
    } else if (
      err === 'rrule_bymonthday' ||
      err === 'rrule_bymonth' ||
      err === 'rrule_byday' ||
      err === 'rrule_until'
    ) {
      parts.delete(
        err === 'rrule_bymonthday'
          ? 'BYMONTHDAY'
          : err === 'rrule_bymonth'
            ? 'BYMONTH'
            : err === 'rrule_byday'
              ? 'BYDAY'
              : 'UNTIL',
      );
    } else if (err === 'rrule_freq' || err === 'rrule_syntax' || err === 'rrule_length')
      return { rrule: null, simplified };
    else if (err === 'rrule_duplicate' || err === 'rrule_wkst') {
      if (err === 'rrule_wkst') parts.delete('WKST');
      else return { rrule: null, simplified };
    } else return { rrule: null, simplified };
    parts = new Map(parts);
  }
  return { rrule: null, simplified: true };
}
