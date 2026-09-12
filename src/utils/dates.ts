/**
 * Date resolution for relative wording.
 *
 * Models are unreliable at weekday arithmetic — asked what "this Friday" meant on a
 * Friday, gpt-4o-mini returned a Tuesday. So the calendar is computed here and the
 * model only picks from it. It cannot return a date that does not exist, and it
 * cannot return one whose weekday contradicts what the lecturer said.
 */

export interface CalendarDay {
  /** "Fri 2026-09-18" — what the model sees and chooses between. */
  label: string
  iso: string
  weekday: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The real instant a wall-clock date and time fall on in a given zone.
 *
 * The offset is measured at that instant rather than assumed: Lagos does not observe
 * daylight saving, but the server might, and a schedule built on the server's idea of
 * 8am reminds a student an hour late twice a year.
 */
export function zonedInstant(date: string, time: string, timeZone: string): Date | null {
  if (!/^\d{2}:\d{2}$/.test(time) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null

  const naive = new Date(`${date}T${time}:00Z`)
  if (Number.isNaN(naive.getTime())) return null

  const local = new Date(naive.toLocaleString('en-US', { timeZone }))
  const utc = new Date(naive.toLocaleString('en-US', { timeZone: 'UTC' }))
  return new Date(naive.getTime() + (utc.getTime() - local.getTime()))
}

/** Date parts as they read in the given timezone, not the server's. */
export function zonedDay(date: Date, timeZone: string): CalendarDay {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(date)

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''

  const iso = `${get('year')}-${get('month')}-${get('day')}`
  const weekday = get('weekday')
  return { label: `${weekday} ${iso}`, iso, weekday }
}

/**
 * The window offered to the extractor. Starts the day before so a message read
 * shortly after midnight can still resolve "yesterday" and "last night".
 */
export function calendarWindow(from: Date, timeZone: string, days = 14): CalendarDay[] {
  const window: CalendarDay[] = []
  for (let offset = -1; offset < days; offset += 1) {
    window.push(zonedDay(new Date(from.getTime() + offset * DAY_MS), timeZone))
  }
  return window
}

/**
 * The ISO date out of whatever the model actually returned.
 *
 * The calendar is offered as labels — "Tue 2026-09-22" — because the weekday is what
 * stops the model doing its own arithmetic. Asked to copy a value from that list, it
 * quite reasonably copies the whole label. Validating the raw string then rejects a
 * date that was chosen correctly, and the event silently loses its date.
 */
export function isoFromAnswer(value: string | null | undefined): string | null {
  if (!value) return null
  return /(\d{4}-\d{2}-\d{2})/.exec(value)?.[1] ?? null
}

/**
 * Null over guessing: a date the model invented rather than chose is discarded.
 * Its `originalDateText` survives, so the citation still carries what was said.
 */
export function isOfferedDate(iso: string | null, window: CalendarDay[]): boolean {
  if (!iso) return false
  return window.some((day) => day.iso === iso)
}

/**
 * An explicit date needs no calendar.
 *
 * The offered window exists so the model never does weekday arithmetic. But "the
 * exam is on 15 October" states a date outright, and rejecting it for being outside
 * a fortnight loses every end-of-semester deadline. Absolute dates are accepted on
 * their own terms — validated deterministically, and only looking forward, so a
 * mistyped year cannot schedule a reminder in the past.
 */
export function isPlausibleAbsoluteDate(
  iso: string | null,
  from: Date,
  horizonDays = 400,
): boolean {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  const parsed = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return false
  // Round-trip: rejects 2026-02-31, which Date would silently roll into March.
  if (parsed.toISOString().slice(0, 10) !== iso) return false

  const days = (parsed.getTime() - from.getTime()) / 86_400_000
  return days >= -2 && days <= horizonDays
}

export function todayIso(timeZone: string, now = new Date()): string {
  return zonedDay(now, timeZone).iso
}

/**
 * Stored times are 24-hour (`23:59`) because that sorts and compares correctly.
 * Everything a student reads is 12-hour, because that is how people here say it.
 */
export function formatTime12(hhmm: string | null | undefined): string | null {
  if (!hhmm) return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!match) return hhmm
  const hours = Number(match[1])
  const minutes = match[2]!
  if (hours > 23 || Number(minutes) > 59) return hhmm
  const period = hours < 12 ? 'am' : 'pm'
  const display = hours % 12 === 0 ? 12 : hours % 12
  return minutes === '00' ? `${display}${period}` : `${display}:${minutes}${period}`
}

/** A timestamp as a student reads it: "Sat 7:41am". */
export function formatStamp(date: Date, timeZone: string): string {
  return date.toLocaleString('en-GB', {
    timeZone,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/** A full date and time, for citing a source. */
export function formatDateTime(date: Date, timeZone: string): string {
  return date.toLocaleString('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/**
 * The instant a calendar day begins in a given zone, as a real Date.
 *
 * Needed because a pause "until Monday" has to resume at Lagos midnight, not the
 * server's. Measured rather than assumed: the offset is read at the target instant,
 * so a zone that shifts mid-pause still lands on its own midnight.
 */
export function zonedStartOfDay(iso: string, timeZone: string): Date {
  const guess = new Date(`${iso}T00:00:00Z`)
  return new Date(guess.getTime() - zonedOffsetMs(guess, timeZone))
}

function zonedOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)

  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)

  // Intl renders midnight as hour 24 rather than 0.
  const hour = get('hour') % 24
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    hour,
    get('minute'),
    get('second'),
  )
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}
