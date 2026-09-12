import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { ReadTimetable } from './timetable.service.js'
import type { ScheduleEntry, User } from '../models/index.js'
import { extractionRepository, scheduleRepository } from '../repositories/index.js'
import type { Extraction } from '../models/index.js'
import { courseDisplay } from '../utils/courses.js'
import {
  formatTime12,
  isPlausibleAbsoluteDate,
  isoFromAnswer,
  zonedDay,
  zonedInstant,
  type CalendarDay,
} from '../utils/dates.js'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Weekly items replace weekly items; dated ones replace dated ones. */
const WEEKLY_KINDS = ['lecture', 'tutorial', 'practical']
const DATED_KINDS = ['exam', 'test']

/** What the student says has changed about one of their own entries. */
export interface Correction {
  kind: 'exam' | 'test' | 'lecture' | 'tutorial' | 'practical' | 'any'
  time: string | null
  venue: string | null
  weekday: string | null
  date: string | null
  remove: boolean
}

/**
 * How far ahead they are asking.
 *
 * A named weekday is its own horizon. Folded into "week" it returns all seven days,
 * and folded into "tomorrow" — which is what the model reached for — it answers a
 * question nobody asked. The model only names the day; the date is resolved here,
 * because the model does not calculate dates.
 */
export type Weekday =
  'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday'
export type Horizon = 'today' | 'tomorrow' | 'week' | 'next' | Weekday

/** One thing coming up, from a timetable row or from what a group announced. */
interface Upcoming {
  kind: string
  courseKey: string | null
  at: Date
  time: string | null
  venue: string | null
  announced: boolean
}

export class ScheduleService {
  /**
   * Stores a timetable the student has already agreed is right.
   *
   * Replaces the previous upload of the same kind rather than adding to it. People
   * re-send a timetable when it changes, and keeping both leaves them reminded of an
   * exam that moved. The photograph itself stays in `messages`, so a superseded
   * version is recoverable.
   */
  async apply(user: User, read: ReadTimetable): Promise<number> {
    const entries = read.entries
      .filter((entry) => entry.courseKey === null || user.courseKeys.includes(entry.courseKey))
      .map((entry) => ({ ...entry, phone: user.phone }))

    if (entries.length === 0) return 0

    const kinds = [...new Set(entries.map((entry) => entry.kind))]
    const replacing = kinds.some((kind) => WEEKLY_KINDS.includes(kind))
      ? WEEKLY_KINDS
      : kinds.some((kind) => DATED_KINDS.includes(kind))
        ? DATED_KINDS
        : []

    const removed = await scheduleRepository.replaceKinds(user.phone, replacing)
    await scheduleRepository.insertMany(entries)
    logger.info({ phone: user.phone, added: entries.length, removed }, 'schedule stored')
    return entries.length
  }

  /**
   * Reads back what was understood, before anything is stored.
   *
   * The student cannot see what the OCR made of their handwriting, and a silently
   * accepted misreading turns up weeks later as a reminder for the wrong day.
   */
  preview(read: ReadTimetable, user: User): string {
    const mine = read.entries.filter(
      (entry) => entry.courseKey === null || user.courseKeys.includes(entry.courseKey),
    )
    const foreign = read.entries.length - mine.length

    const lines = mine.map((entry) => {
      const course = entry.courseKey ? `*${courseDisplay(entry.courseKey)}*` : '*(no code)*'
      const when = entry.weekday !== null ? WEEKDAYS[entry.weekday]! : (entry.date ?? 'no date')
      const at = entry.time ? ` ${formatTime12(entry.time)}` : ''
      const where = entry.venue ? `, ${entry.venue}` : ''
      return `• ${course} — ${when}${at}${where} _(${entry.kind})_`
    })

    const heading =
      read.kind === 'exam_timetable'
        ? `That looks like your *exam timetable*. Here's what I read:`
        : `That looks like your *class timetable*. Here's what I read:`

    // Never silently drop rows: a student who sees eight of ten lines assumes the
    // other two were missed, and a line explaining why is the difference between a
    // trustworthy read and an unexplained gap.
    const skipped = foreign
      ? `\n\n_I left out ${foreign} row${foreign === 1 ? '' : 's'} for courses you're not registered for._`
      : ''

    return `${heading}\n\n${lines.join('\n')}${skipped}\n\nIs that right? Send *yes* and I'll remind you about these. If anything's wrong, send a clearer picture.`
  }

  /**
   * A correction made in words rather than by re-sending the photograph.
   *
   * Nobody re-photographs a timetable because one room changed. Refusing the spoken
   * version means the stored copy drifts out of date and the reminders it drives go
   * quietly wrong — which is worse than having no timetable at all.
   */
  async amend(
    user: User,
    courseKey: string,
    correction: Correction,
    now = new Date(),
  ): Promise<string> {
    const course = courseDisplay(courseKey) ?? courseKey
    const kind = correction.kind === 'any' ? null : correction.kind

    const existing = (await scheduleRepository.forStudent(user.phone)).filter(
      (entry) => entry.courseKey === courseKey && (!kind || entry.kind === kind),
    )
    if (existing.length === 0) {
      return `I don't have ${kind ? `a ${kind} ` : 'anything '}for *${course}* on your timetable, so there's nothing to change. Send me a photo of it and I'll keep track.`
    }

    if (correction.remove) {
      const removed = await scheduleRepository.remove(user.phone, courseKey, kind)
      return `Removed ${removed} ${kind ?? 'item'}${removed === 1 ? '' : 's'} for *${course}*.`
    }

    const patch: { time?: string; venue?: string; date?: string; weekday?: number } = {}
    const said: string[] = []

    if (correction.time) {
      patch.time = correction.time
      said.push(`at *${formatTime12(correction.time)}*`)
    }
    if (correction.venue) {
      patch.venue = correction.venue
      said.push(`in *${correction.venue}*`)
    }
    if (correction.date) {
      const date = isoFromAnswer(correction.date)
      // Same rule as everywhere else: a date the model invented is not a date.
      if (date && isPlausibleAbsoluteDate(date, now)) {
        patch.date = date
        patch.weekday = undefined as never
        said.push(`on *${date}*`)
      }
    }
    const weekday = weekdayIndexOf(correction.weekday)
    if (weekday !== null && !patch.date) {
      patch.weekday = weekday
      said.push(`on *${WEEKDAYS[weekday]}*`)
    }

    if (said.length === 0) {
      return `I didn't catch what changed about *${course}*. Tell me like *CVE 575 lecture is now 10am in LG8*.`
    }

    const changed = await scheduleRepository.amend(user.phone, courseKey, kind, patch)
    return `Updated — *${course}*${kind ? ` ${kind}` : ''} is now ${said.join(' ')}.

${changed === 1 ? "I'll remind you at the new time." : `That changed ${changed} entries.`}`
  }

  async forStudent(phone: string): Promise<ScheduleEntry[]> {
    return scheduleRepository.forStudent(phone)
  }

  /**
   * Answers a question about their own timetable.
   *
   * Deterministic, and merged with what the groups announced. "What have I got
   * today?" is one question with two sources — the weekly lecture from the
   * photograph they sent, and the test a lecturer moved this morning — and answering
   * from either alone is answering half of it.
   *
   * Returns null when they have no timetable stored, so the caller can offer to read
   * one rather than reporting an empty week as though it were the answer.
   */
  async answer(
    user: User,
    when: Horizon,
    courseKey: string | null,
    now = new Date(),
  ): Promise<string | null> {
    const stored = await scheduleRepository.forStudent(user.phone)
    const scoped = courseKey ? stored.filter((entry) => entry.courseKey === courseKey) : stored

    if (stored.length === 0 && when !== 'next') return null

    const today = zonedDay(now, config.digest.timezone)
    const days = this.horizon(when, now)

    // "next" is answerable with no timetable at all — a test announced in a group is
    // the next thing coming up whether or not one was ever photographed — so the
    // never-seen check belongs inside it, where the announcements have been read.
    if (when === 'next') return this.nextUp(user, scoped, courseKey, now, stored.length > 0)

    const lines: string[] = []
    for (const day of days) {
      const weekday = new Date(`${day.iso}T12:00:00Z`).getUTCDay()
      const mine = scoped.filter((entry) => entry.date === day.iso || entry.weekday === weekday)
      const announced = await extractionRepository.dueOn(
        courseKey ? [courseKey] : user.courseKeys,
        day.iso,
      )
      if (mine.length === 0 && announced.length === 0) continue

      const heading = day.iso === today.iso ? 'Today' : `${WEEKDAYS[weekday]!} ${day.iso.slice(5)}`
      lines.push(
        `*${heading}*`,
        ...[...mine.map(describeEntry), ...announced.map(describeAnnounced)].sort(),
        '',
      )
    }

    if (lines.length === 0) {
      const scope = courseKey ? ` for ${courseDisplay(courseKey)}` : ''
      return `Nothing on your timetable${scope} ${this.label(when, days)}.`
    }

    return lines.join('\n').trim()
  }

  /**
   * "When is my next class?" — the soonest thing coming up, from every source.
   *
   * A weekly class has a weekday and no date, so looking only at dated rows answers
   * "nothing on your timetable" to somebody who has a lecture in the morning. The next
   * occurrence of a weekly row is as real a date as one written on an exam sheet.
   */
  private async nextUp(
    user: User,
    stored: ScheduleEntry[],
    courseKey: string | null,
    now: Date,
    hasTimetable: boolean,
  ): Promise<string | null> {
    const zone = config.digest.timezone
    const upcoming: Upcoming[] = []

    for (const entry of stored) {
      const at = nextOccurrence(entry, now, zone)
      if (!at) continue
      upcoming.push({
        kind: entry.kind,
        courseKey: entry.courseKey,
        at,
        time: entry.time,
        venue: entry.venue,
        announced: false,
      })
    }

    // What a group announced counts too: a test moved to Thursday is the next thing
    // coming up whether or not it was ever on a photographed timetable.
    const scope = courseKey ? [courseKey] : user.courseKeys
    if (scope.length > 0) {
      const since = new Date(now.getTime() - 30 * 86_400_000)
      for (const item of await extractionRepository.forCourses(scope, since)) {
        if (!item.date) continue
        const at = zonedInstant(item.date, item.time ?? '08:00', zone)
        if (!at || at.getTime() <= now.getTime()) continue
        upcoming.push({
          kind: item.eventType,
          courseKey: item.courseKey,
          at,
          time: item.time,
          venue: item.venue,
          announced: true,
        })
      }
    }

    upcoming.sort((a, b) => a.at.getTime() - b.at.getTime())

    const [next] = upcoming
    if (!next) {
      // Null means Peermate has never been shown a timetable, which the caller says in
      // its own words. "Nothing coming up" is for a timetable it has and that is empty
      // — the same sentence for both makes the two indistinguishable to the student.
      if (!hasTimetable) return null

      const only = courseKey ? ` for ${courseDisplay(courseKey)}` : ''
      return `Nothing coming up${only} that I know of.`
    }

    const rest = upcoming.slice(1, 4)
    const after = rest.length
      ? `\n\n*After that*\n${rest.map((item) => `• ${courseDisplay(item.courseKey) ?? '?'} ${item.kind} — ${dayLabel(item.at, now, zone)}${item.time ? ` at ${formatTime12(item.time)}` : ''}`).join('\n')}`
      : ''

    return `*Next ${next.kind}: ${courseDisplay(next.courseKey) ?? 'your course'}*
${dayLabel(next.at, now, zone)}${next.time ? ` at ${formatTime12(next.time)}` : ''}${next.venue ? `, ${next.venue}` : ''}${next.announced ? ' _(announced in your group)_' : ''}${after}`
  }

  private horizon(when: Horizon, now: Date): CalendarDay[] {
    const day = (offset: number): CalendarDay =>
      zonedDay(new Date(now.getTime() + offset * 86_400_000), config.digest.timezone)

    if (when === 'today') return [day(0)]
    if (when === 'tomorrow') return [day(1)]

    const named = WEEKDAYS.findIndex((name) => name.toLowerCase() === when)
    if (named >= 0) {
      const today = new Date(`${day(0).iso}T12:00:00Z`).getUTCDay()
      // The coming one, and today when today is that day: asked on a Tuesday, "on
      // Tuesday" means today far more often than it means a week from now.
      return [day((named - today + 7) % 7)]
    }

    return Array.from({ length: 7 }, (_, index) => day(index))
  }

  /** How to name the span in a sentence, for when there is nothing in it. */
  private label(when: Horizon, days: CalendarDay[]): string {
    if (when === 'today') return 'today'
    if (when === 'tomorrow') return 'tomorrow'
    if (when === 'week') return 'this week'

    const [only] = days
    if (!only) return 'then'
    return `on ${WEEKDAYS[new Date(`${only.iso}T12:00:00Z`).getUTCDay()]} ${only.iso.slice(5)}`
  }

  /** Everything on today, for a digest line or a "what have I got today?" answer. */
  async today(phone: string, now = new Date()): Promise<ScheduleEntry[]> {
    const { iso } = zonedDay(now, config.digest.timezone)
    const weekday = new Date(`${iso}T12:00:00Z`).getUTCDay()

    const all = await scheduleRepository.forStudent(phone)
    return all
      .filter((entry) => entry.date === iso || entry.weekday === weekday)
      .sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99'))
  }
}

export const scheduleService = new ScheduleService()

/** The next time a row comes round: its own date, or the coming weekday. */
function nextOccurrence(entry: ScheduleEntry, now: Date, zone: string): Date | null {
  if (entry.date) {
    const at = zonedInstant(entry.date, entry.time ?? '08:00', zone)
    return at && at.getTime() > now.getTime() ? at : null
  }
  if (entry.weekday === null) return null

  for (let offset = 0; offset <= 7; offset += 1) {
    const day = zonedDay(new Date(now.getTime() + offset * 86_400_000), zone)
    if (new Date(`${day.iso}T12:00:00Z`).getUTCDay() !== entry.weekday) continue
    const at = zonedInstant(day.iso, entry.time ?? '08:00', zone)
    if (at && at.getTime() > now.getTime()) return at
  }
  return null
}

/** "Today", "Tomorrow", then the weekday — nobody counts dates in their head. */
function dayLabel(at: Date, now: Date, zone: string): string {
  const day = zonedDay(at, zone)
  const today = zonedDay(now, zone)
  if (day.iso === today.iso) return 'Today'

  const tomorrow = zonedDay(new Date(now.getTime() + 86_400_000), zone)
  if (day.iso === tomorrow.iso) return 'Tomorrow'

  return `${WEEKDAYS[new Date(`${day.iso}T12:00:00Z`).getUTCDay()]} ${day.iso.slice(5)}`
}

function describeEntry(entry: ScheduleEntry): string {
  const at = entry.time ? formatTime12(entry.time) : '—'
  const where = entry.venue ? `, ${entry.venue}` : ''
  return `• ${at} — ${courseDisplay(entry.courseKey) ?? 'your course'} ${entry.kind}${where}`
}

/** Marked, because it came from a group rather than from their own timetable. */
function describeAnnounced(item: Extraction): string {
  const at = item.time ? formatTime12(item.time) : '—'
  const where = item.venue ? `, ${item.venue}` : ''
  return `• ${at} — ${courseDisplay(item.courseKey) ?? 'your course'} ${item.eventType.replace('_', ' ')}${where} _(announced)_`
}

function weekdayIndexOf(name: string | null): number | null {
  if (!name) return null
  const index = WEEKDAYS.findIndex((day) =>
    day.toLowerCase().startsWith(name.trim().toLowerCase().slice(0, 3)),
  )
  return index >= 0 ? index : null
}
