// The calendar entry point (`@os-planner/shared/calendar`): event schemas, limits, recurrence rules (RRULE subset, evaluated on the
// wall clock of the event's zone) and their expansion, and the plain-language description of a rule. Kept apart from the main entry
// so the website's first load does not carry them: only the calendar screens (a lazy chunk) and the server import it. The TYPES are
// also exported from the main entry.
export * from './dto/calendar';
export * from './calendar/tz';
export * from './calendar/rrule';
export * from './calendar/expand';
export * from './calendar/timing';
export * from './calendar/describe';
