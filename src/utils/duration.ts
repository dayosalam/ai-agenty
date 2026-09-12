import { zonedDay, zonedStartOfDay } from './dates.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export interface Pause {
  /** Null when they named no end — only an explicit "resume" lifts it. */
  until: Date | null
}

/**
 * How long "pause alerts until Monday" means.
 *
 * Deliberately narrow. A student writing "pause until after exams" is naming
 * something Peermate cannot resolve, and inventing a date for it would resume at a
 * moment they never agreed to — an indefinite pause they can lift in one word is the
 * honest reading. Only wording with a real endpoint produces one.
 */
export function parsePause(text: string, timeZone: string, now = new Date()): Pause {
  const lower = text.toLowerCase()

  const counted = /\bfor\s+(?:(\d+)|an?|one|two|three)\s*(hour|hr|day|week)s?\b/.exec(lower)
  if (counted) {
    const words: Record<string, number> = { two: 2, three: 3 }
    const said = counted[0].match(/\btwo\b|\bthree\b/)?.[0]
    const count = counted[1] ? Number(counted[1]) : said ? words[said]! : 1
    const unit = counted[2]!
    const span = unit === 'week' ? 7 * DAY_MS : unit === 'day' ? DAY_MS : HOUR_MS
    return { until: new Date(now.getTime() + count * span) }
  }

  // "for the weekend" and "until Monday" are the same request said two ways.
  if (/\b(the\s+)?weekend\b/.test(lower)) return { until: nextWeekday('mon', timeZone, now) }
  if (/\b(until|till|til|to)\s+next\s+week\b/.test(lower)) {
    return { until: nextWeekday('mon', timeZone, now) }
  }

  const named = /\b(until|till|til|to)\s+(?:next\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*/.exec(
    lower,
  )
  if (named) return { until: nextWeekday(named[2]!, timeZone, now) }

  if (/\b(until|till|til)\s+tomorrow\b/.test(lower)) {
    return {
      until: zonedStartOfDay(zonedDay(new Date(now.getTime() + DAY_MS), timeZone).iso, timeZone),
    }
  }
  if (/\b(until|till|til)\s+(this\s+)?(evening|tonight)\b/.test(lower)) {
    return { until: new Date(now.getTime() + 6 * HOUR_MS) }
  }

  return { until: null }
}

/**
 * The next time that weekday comes round, at the start of the day.
 *
 * Strictly after today: somebody saying "pause until Monday" on a Monday means the
 * next one, not the minute they are already past.
 */
function nextWeekday(target: string, timeZone: string, now: Date): Date {
  const index = WEEKDAYS.indexOf(target.slice(0, 3))
  for (let offset = 1; offset <= 7; offset += 1) {
    const day = zonedDay(new Date(now.getTime() + offset * DAY_MS), timeZone)
    if (WEEKDAYS.indexOf(day.weekday.slice(0, 3).toLowerCase()) === index) {
      return zonedStartOfDay(day.iso, timeZone)
    }
  }
  return new Date(now.getTime() + 7 * DAY_MS)
}

/** "Monday 15 Sep" or "4:30pm today" — whichever the student would actually say. */
export function describeResume(until: Date, timeZone: string): string {
  const sameDay = zonedDay(until, timeZone).iso === zonedDay(new Date(), timeZone).iso
  if (until.getTime() - Date.now() < 20 * HOUR_MS && sameDay) {
    return `${until.toLocaleString('en-GB', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true })} today`
  }
  return until.toLocaleString('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  })
}
