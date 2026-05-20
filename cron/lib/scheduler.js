'use strict';

/**
 * cron/lib/scheduler.js — pure scheduler core for the openclaw-cron daemon.
 *
 * Zero external dependencies. Exports a minimal but correct 5-field POSIX
 * cron parser plus a tick() function that the daemon calls once per minute
 * to determine which jobs are due.
 *
 * Field order (standard 5-field cron):
 *   minute (0-59) hour (0-23) day-of-month (1-31) month (1-12) day-of-week (0-6, 0=Sun)
 *
 * Supported per-field syntax:
 *   *              every value
 *   N              single integer
 *   N,M,O          comma-separated list
 *   N-M            inclusive range
 *   M-N/S          range with step
 *   *\/S            every Sth value across the full range
 *
 * Day-of-month and day-of-week are OR'd (standard cron behavior): a day
 * matches if either field's set includes it, unless one of them is `*`
 * in which case only the other constrains.
 */

const FIELD_BOUNDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 6 },
];

class CronParseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CronParseError';
    this.details = details;
  }
}

/**
 * Parse a 5-field cron string into a normalized field set.
 * Returns an object: { fields: [Set, Set, Set, Set, Set], starOf: [bool,...] }
 * where each Set contains the allowed integer values for that field, and
 * starOf[i] is true iff the i-th field was literally `*` (used for the
 * dom/dow OR-coupling rule).
 */
function parseSchedule(expr) {
  if (typeof expr !== 'string' || !expr.trim()) {
    throw new CronParseError('cron expression must be a non-empty string');
  }
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(`cron expression must have 5 fields, got ${parts.length}`, { expr });
  }
  const fields = [];
  const starOf = [];
  for (let i = 0; i < 5; i += 1) {
    const { set, isStar } = parseField(parts[i], FIELD_BOUNDS[i]);
    fields.push(set);
    starOf.push(isStar);
  }
  return { fields, starOf, expr };
}

function parseField(token, bound) {
  // Returns { set: Set<number>, isStar: boolean }.
  const out = new Set();
  let isStar = false;
  const subs = token.split(',');
  for (const sub of subs) {
    parseSubExpression(sub, bound, out, (flag) => { if (flag) isStar = true; });
  }
  if (out.size === 0) {
    throw new CronParseError(`field "${token}" matches no values`, { token, field: bound.name });
  }
  return { set: out, isStar: isStar && subs.length === 1 };
}

function parseSubExpression(sub, bound, out, markStar) {
  let stepPart = null;
  let rangePart = sub;
  const slashIdx = sub.indexOf('/');
  if (slashIdx >= 0) {
    rangePart = sub.slice(0, slashIdx);
    stepPart = sub.slice(slashIdx + 1);
  }
  const step = stepPart == null ? 1 : parseIntStrict(stepPart, 'step');
  if (step <= 0) throw new CronParseError(`step must be > 0, got ${stepPart}`, { sub });

  let lo;
  let hi;
  if (rangePart === '*' || rangePart === '') {
    lo = bound.min;
    hi = bound.max;
    if (stepPart == null && rangePart === '*') markStar(true);
  } else if (rangePart.includes('-')) {
    const [a, b] = rangePart.split('-');
    lo = parseIntStrict(a, 'range-start');
    hi = parseIntStrict(b, 'range-end');
    if (lo > hi) {
      throw new CronParseError(`range start ${lo} greater than end ${hi}`, { sub });
    }
  } else {
    lo = parseIntStrict(rangePart, 'value');
    hi = lo;
  }

  if (lo < bound.min || hi > bound.max) {
    throw new CronParseError(
      `value out of range for ${bound.name}: ${lo}-${hi} (allowed ${bound.min}-${bound.max})`,
      { sub, field: bound.name },
    );
  }

  for (let v = lo; v <= hi; v += step) out.add(v);
}

function parseIntStrict(s, label) {
  if (!/^\d+$/.test(s)) {
    throw new CronParseError(`${label} must be a non-negative integer, got "${s}"`);
  }
  return Number(s);
}

/**
 * Compute the next scheduled run time after `fromDate` (exclusive). Returns
 * a Date in UTC. The daemon stays in UTC to keep schedule semantics
 * portable across operator machines (operators schedule against UTC).
 *
 * Implementation: minute-by-minute scan up to a safe horizon (4 years).
 * For the cron expressions documented in jobs.json (daily, hourly,
 * 15-minute, monthly, etc.) this terminates in at most a few thousand
 * iterations.
 */
function nextRun(parsed, fromDate) {
  const start = new Date(fromDate.getTime());
  // advance to the next whole minute boundary
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);

  const horizon = new Date(start.getTime());
  horizon.setUTCFullYear(horizon.getUTCFullYear() + 4);

  for (let cursor = start; cursor < horizon;) {
    if (matches(parsed, cursor)) return new Date(cursor.getTime());
    cursor = new Date(cursor.getTime() + 60 * 1000);
  }
  throw new CronParseError('no matching run found within 4-year horizon', { expr: parsed.expr });
}

function matches(parsed, date) {
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dom = date.getUTCDate();
  const month = date.getUTCMonth() + 1;
  const dow = date.getUTCDay();

  if (!parsed.fields[0].has(minute)) return false;
  if (!parsed.fields[1].has(hour)) return false;
  if (!parsed.fields[3].has(month)) return false;

  // dom/dow OR-coupling rule per POSIX cron.
  const domStar = parsed.starOf[2];
  const dowStar = parsed.starOf[4];
  const domHit = parsed.fields[2].has(dom);
  const dowHit = parsed.fields[4].has(dow);

  if (domStar && dowStar) return true;
  if (domStar) return dowHit;
  if (dowStar) return domHit;
  return domHit || dowHit;
}

/**
 * tick(jobs, lastRunMap, now) -> [{ job, dueAt }]
 *
 * jobs: array of { id, schedule, role, subject, body } records as read
 *       from cron/jobs.json.
 * lastRunMap: Map<jobId, ISOString>. The daemon persists this so a
 *       restart after a missed minute does not double-fire.
 * now: Date — the current tick wall clock (UTC).
 *
 * Returns the list of jobs whose nextRun(lastRunOrEpoch) is <= now.
 * The returned objects carry the computed dueAt so callers can record
 * it back into lastRunMap after a successful blackboard write.
 *
 * Invariants:
 *   - Each job is returned at most once per tick.
 *   - A job whose schedule fires every minute will still only emit one
 *     dueAt per call (the most recent past minute up to now).
 *   - Jobs without a known lastRun start from one minute before `now`
 *     so the first tick after install does not back-fill the entire
 *     epoch worth of schedule occurrences.
 */
function tick(jobs, lastRunMap, now) {
  const out = [];
  // For jobs with no prior lastRun, treat them as if they last ran one
  // minute ago. This prevents a fresh install from back-filling years
  // of schedule occurrences while still honoring a real lastRun stamp.
  const firstSeenFloor = new Date(now.getTime() - 60 * 1000);
  for (const job of jobs) {
    if (!job || typeof job.id !== 'string' || !job.id) continue;
    let parsed;
    try {
      parsed = parseSchedule(job.schedule);
    } catch (err) {
      // Surface the parse error to the caller as a synthetic dueAt with
      // a parseError field; the daemon logs and skips.
      out.push({ job, dueAt: null, parseError: err.message });
      continue;
    }
    const lastRunIso = lastRunMap.get(job.id);
    const since = lastRunIso ? new Date(lastRunIso) : firstSeenFloor;
    let next;
    try {
      next = nextRun(parsed, since);
    } catch (err) {
      out.push({ job, dueAt: null, parseError: err.message });
      continue;
    }
    if (next.getTime() <= now.getTime()) {
      out.push({ job, dueAt: next });
    }
  }
  return out;
}

module.exports = {
  parseSchedule,
  parseField,
  nextRun,
  matches,
  tick,
  CronParseError,
  FIELD_BOUNDS,
};
