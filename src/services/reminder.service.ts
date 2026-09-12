import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { ScheduleEntry, User } from '../models/index.js'
import {
  extractionRepository,
  notificationRepository,
  scheduleRepository,
  userRepository,
} from '../repositories/index.js'
import { courseDisplay } from '../utils/courses.js'
import { formatTime12, zonedDay, zonedInstant } from '../utils/dates.js'
import { conversationService } from './conversation.service.js'
import { deliveryService } from './delivery.service.js'
import { notifierService } from './notifier.service.js'

const MINUTE_MS = 60 * 1000

/**
 * How much warning each thing is worth.
 *
 * An exam you prepare for the night before; a lecture you walk to. Reminding an hour
 * ahead of an exam is useless and reminding a day ahead of a lecture is noise, so the
 * lead time is a property of what is being missed rather than one global setting.
 */
const LEAD_MINUTES: Record<string, number[]> = {
  exam: [24 * 60, 120],
  test: [24 * 60, 120],
  lecture: [45],
  tutorial: [45],
  practical: [45],
  assignment: [24 * 60],
  deadline: [24 * 60],
}

/**
 * Fires anything whose lead time falls inside this window.
 *
 * Deliberately wider than the scheduler's 15-minute tick. Exactly equal, a single
 * slow or skipped run drops the reminder for good — there is no later tick that still
 * matches. The overlap is free because delivery is deduped per event and lead.
 */
const WINDOW_MINUTES = 20

interface Due {
  id: string
  /** Set only for an announced event: a timetable row is not something to reply to. */
  eventId: string | null
  kind: string
  courseKey: string | null
  at: Date
  lead: number
  time: string | null
  venue: string | null
}

/**
 * The message that arrives before the thing, not after it.
 *
 * Announcements tell a student something exists; the digest tells them what is
 * coming. Neither helps at 7:45 when a 8:00 lecture moved rooms. Reminders close
 * that gap, from two sources — what a group announced, and the timetable the student
 * photographed themselves.
 *
 * Everything goes through DeliveryService, so a pause or quiet hours holds a reminder
 * exactly as it holds an alert. Nothing here bypasses a student's own settings.
 */
export class ReminderService {
  async run(now = new Date()): Promise<void> {
    const students = await userRepository.allRegistered()
    for (const student of students) {
      try {
        await this.runFor(student, now)
      } catch (error) {
        logger.error({ err: error, phone: student.phone }, 'reminders failed')
      }
    }
  }

  async runFor(student: User, now = new Date()): Promise<number> {
    const due = [
      ...(await this.fromSchedule(student, now)),
      ...(await this.fromAnnouncements(student, now)),
    ]

    let sent = 0
    for (const item of due) {
      // Keyed by lead as well as by event: the day-before and the two-hour warning
      // are two different reminders about one exam, and neither should suppress the
      // other — while a scheduler that fires twice should send neither twice.
      const id = `reminder:${item.id}:${item.lead}`
      if (await notificationRepository.alreadySent(student.phone, id, 'reminder', dayStart(now))) {
        continue
      }

      const delivered = await deliveryService.send(student, this.format(item, now), {
        kind: 'announcement',
        courseKey: item.courseKey,
        eventType: item.kind === 'exam' || item.kind === 'test' ? 'test' : null,
        eventId: item.eventId,
      })
      if (!delivered) continue

      // So "what about it?" or "is there material for that course?" straight after a
      // reminder has something to refer to, instead of resolving against nothing.
      await conversationService.rememberCourse(student.phone, item.courseKey)

      await notificationRepository.log({
        userPhone: student.phone,
        extractionId: id,
        notificationType: 'reminder',
        status: 'sent',
        error: null,
        sentAt: new Date(),
      })
      sent += 1
    }

    if (sent > 0) logger.info({ phone: student.phone, sent }, 'reminders sent')
    return sent
  }

  /**
   * Sends one reminder for whatever is closest, after a short delay.
   *
   * A demo aid. Reminders are the one feature that cannot be shown on camera without
   * waiting for the clock, so this fires the real formatter over the real data — it
   * is a shortcut through the *timing*, not a fake message.
   *
   * Sent directly rather than through DeliveryService: that gate exists for messages
   * the student did not ask for, and this one was asked for by name. Quiet hours or a
   * pause silently eating the demo would be the worst possible behaviour here.
   *
   * Returns null once the reminder is scheduled. An acknowledgement would be the first
   * thing on screen and would announce the delay, which is exactly what the demo is
   * trying not to show; only a failure is worth saying out loud.
   */
  async previewIn(student: User, delayMs: number): Promise<string | null> {
    const next = await this.nearest(student)
    if (!next) {
      return `Nothing upcoming to remind you about. Send me a photo of your timetable first, or get something announced in a group.`
    }

    const timer = setTimeout(() => {
      void notifierService
        .sendText(student.jid, this.format(next, new Date()))
        .then(() => conversationService.rememberCourse(student.phone, next.courseKey))
        .catch((error) => logger.error({ err: error }, 'reminder preview failed'))
    }, delayMs)
    timer.unref?.()

    return null
  }

  /** The soonest thing coming up, from either source, whatever its lead time. */
  private async nearest(student: User, now = new Date()): Promise<Due | null> {
    const horizon = new Date(now.getTime() - 30 * 24 * 60 * MINUTE_MS)
    const candidates: Due[] = []

    for (const entry of await scheduleRepository.forStudent(student.phone)) {
      const at = this.nextOccurrence(entry, now)
      if (!at || at.getTime() <= now.getTime()) continue
      candidates.push({
        id: `${entry.sourceMessageId}:${entry.courseKey}:${entry.kind}`,
        eventId: null,
        kind: entry.kind,
        courseKey: entry.courseKey,
        at,
        lead: 0,
        time: entry.time,
        venue: entry.venue,
      })
    }

    if (student.courseKeys.length > 0) {
      for (const item of await extractionRepository.forCourses(student.courseKeys, horizon)) {
        if (!item.date) continue
        const at = instantOf(item.date, item.time ?? '08:00')
        if (!at || at.getTime() <= now.getTime()) continue
        candidates.push({
          id: item.eventId,
          eventId: item.eventId,
          kind: item.eventType,
          courseKey: item.courseKey,
          at,
          lead: 0,
          time: item.time,
          venue: item.venue,
        })
      }
    }

    return candidates.sort((a, b) => a.at.getTime() - b.at.getTime())[0] ?? null
  }

  /** The student's own timetable: dated exams, and lectures that recur weekly. */
  private async fromSchedule(student: User, now: Date): Promise<Due[]> {
    const entries = await scheduleRepository.forStudent(student.phone)
    const due: Due[] = []

    for (const entry of entries) {
      if (!entry.time) continue
      for (const lead of LEAD_MINUTES[entry.kind] ?? []) {
        const at = this.nextOccurrence(entry, now)
        if (!at) continue
        if (!within(at, now, lead)) continue

        due.push({
          id: `${entry.sourceMessageId}:${entry.courseKey}:${entry.kind}:${entry.weekday ?? entry.date}:${entry.time}`,
          eventId: null,
          kind: entry.kind,
          courseKey: entry.courseKey,
          at,
          lead,
          time: entry.time,
          venue: entry.venue,
        })
      }
    }
    return due
  }

  /** What a group announced, which is where a venue change or a moved test comes from. */
  private async fromAnnouncements(student: User, now: Date): Promise<Due[]> {
    if (student.courseKeys.length === 0) return []

    const horizon = new Date(now.getTime() - 30 * 24 * 60 * MINUTE_MS)
    const items = await extractionRepository.forCourses(student.courseKeys, horizon)
    const due: Due[] = []

    for (const item of items) {
      if (!item.date) continue
      for (const lead of LEAD_MINUTES[item.eventType] ?? []) {
        // Without a stated time, treat it as the start of the working day rather than
        // midnight — a "day before" reminder at 00:01 is technically a day before and
        // practically useless.
        const at = instantOf(item.date, item.time ?? '08:00')
        if (!at || !within(at, now, lead)) continue

        due.push({
          id: item.eventId,
          eventId: item.eventId,
          kind: item.eventType,
          courseKey: item.courseKey,
          at,
          lead,
          time: item.time,
          venue: item.venue,
        })
      }
    }
    return due
  }

  /** The next time a weekly entry comes round, or the fixed date of a one-off. */
  private nextOccurrence(entry: ScheduleEntry, now: Date): Date | null {
    if (entry.date) return instantOf(entry.date, entry.time ?? '08:00')
    if (entry.weekday === null) return null

    for (let offset = 0; offset <= 7; offset += 1) {
      const day = zonedDay(
        new Date(now.getTime() + offset * 24 * 60 * MINUTE_MS),
        config.digest.timezone,
      )
      if (new Date(`${day.iso}T12:00:00Z`).getUTCDay() !== entry.weekday) continue
      const at = instantOf(day.iso, entry.time ?? '08:00')
      if (at && at.getTime() > now.getTime()) return at
    }
    return null
  }

  private format(item: Due, now: Date): string {
    const course = item.courseKey ? (courseDisplay(item.courseKey) ?? 'Your course') : 'Your course'
    const kind = item.kind.replace('_', ' ')
    const where = item.venue ? `, ${item.venue}` : ''
    const at = item.time ? formatTime12(item.time) : null

    const away = Math.round((item.at.getTime() - now.getTime()) / MINUTE_MS)
    const howLong =
      away >= 20 * 60
        ? 'tomorrow'
        : away >= 90
          ? `in about ${Math.round(away / 60)} hours`
          : `in ${Math.max(away, 1)} minutes`

    const icon = item.kind === 'exam' || item.kind === 'test' ? '📣' : '⏰'
    return `${icon} *${course} ${kind}* ${howLong}${at ? ` — ${at}` : ''}${where}

_Reminder. Ask me about it and I'll tell you what was said._`
  }
}

/** An ISO date and a 24-hour time, as an instant in the digest timezone. */
const instantOf = (date: string, time: string): Date | null =>
  zonedInstant(date, time, config.digest.timezone)

function within(at: Date, now: Date, leadMinutes: number): boolean {
  const minutesAway = (at.getTime() - now.getTime()) / MINUTE_MS
  return minutesAway <= leadMinutes && minutesAway > leadMinutes - WINDOW_MINUTES
}

function dayStart(now: Date): Date {
  return new Date(`${zonedDay(now, config.digest.timezone).iso}T00:00:00Z`)
}

export const reminderService = new ReminderService()
