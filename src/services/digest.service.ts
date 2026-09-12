import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { Extraction, User } from '../models/index.js'
import {
  extractionRepository,
  messageRepository,
  notificationRepository,
  userRepository,
} from '../repositories/index.js'
import { courseDisplay } from '../utils/courses.js'
import { formatStamp, formatTime12, todayIso } from '../utils/dates.js'
import { deliveryService } from './delivery.service.js'
import { notifierService } from './notifier.service.js'
import { ttsService } from './tts.service.js'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Eight rooms, one thread.
 *
 * The digest is the second differentiator: everything across every course the student
 * takes, aggregated into a single morning message. A chatbox can be in zero rooms.
 */
export class DigestService {
  /** Sends to everyone whose chosen hour is now. */
  async runForHour(hour: number): Promise<void> {
    const students = await userRepository.dueForDigest(hour)
    if (students.length === 0) return

    logger.info({ hour, students: students.length }, 'running digest')
    for (const student of students) {
      try {
        await this.runFor(student)
      } catch (error) {
        logger.error({ err: error, phone: student.phone }, 'digest failed')
      }
    }
  }

  async runForAll(): Promise<void> {
    const students = await userRepository.allRegistered()
    logger.info({ students: students.length }, 'running daily digest')
    for (const student of students) {
      try {
        await this.runFor(student)
      } catch (error) {
        logger.error({ err: error, phone: student.phone }, 'digest failed')
      }
    }
  }

  async runFor(student: User): Promise<void> {
    if (student.courseKeys.length === 0) return

    const since = student.lastDigestAt ?? new Date(Date.now() - DAY_MS)
    const today = todayIso(config.digest.timezone)

    const fresh = await extractionRepository.forCourses(student.courseKeys, since)
    const dueToday = await extractionRepository.dueOn(student.courseKeys, today)
    const items = dedupe([...fresh, ...dueToday])

    // Nothing to report is itself worth reporting — silence is indistinguishable
    // from Peermate being down. Say so plainly; never invent a digest (PRD §11).
    const body =
      items.length > 0
        ? await this.format(items, today, this.greeting(student))
        : `${this.greeting(student)}Nothing new across your courses today. Quiet morning.`

    // Held rather than skipped: lastDigestAt is not advanced below, so whatever this
    // one would have carried turns up in the first digest after the pause lifts.
    const sent = await deliveryService.send(student, body, { kind: 'digest' })
    if (!sent) return

    // Audio after text, never instead of it: the student listens on the way in, and
    // the venue is still there to read and screenshot when they arrive.
    if (student.digestFormat === 'voice' && items.length > 0) {
      const audio = await ttsService.speak(body)
      if (audio) await notifierService.sendVoiceNote(student.jid, audio)
    }

    await notificationRepository.log({
      userPhone: student.phone,
      extractionId: null,
      notificationType: 'digest',
      status: 'sent',
      error: null,
      sentAt: new Date(),
    })
    await userRepository.upsert({ ...student, lastDigestAt: new Date() })
    logger.info({ phone: student.phone, items: items.length }, 'digest sent')
  }

  /**
   * A catch-up the student asked for: "what have I missed this week?"
   *
   * Same shape as the morning digest over a window they chose. It deliberately does
   * not touch lastDigestAt — asking what happened last week must not silence
   * tomorrow morning's digest.
   */
  async catchUp(student: User, sinceDays: number, label: string): Promise<string> {
    if (student.courseKeys.length === 0) {
      return "You're not watching any courses yet, so there's nothing to catch up on."
    }

    const since = new Date(Date.now() - sinceDays * DAY_MS)
    const items = dedupe(await extractionRepository.forCourses(student.courseKeys, since))

    if (items.length === 0) {
      const courses = student.courseKeys.map(courseDisplay).filter(Boolean).join(', ')
      return `Nothing has come up in ${courses} ${label}.`
    }

    const today = todayIso(config.digest.timezone)
    return this.format(items, today, `Here's what happened ${label} 👇\n\n`)
  }

  private greeting(student: User): string {
    return student.displayName ? `Morning ${student.displayName} 👋\n\n` : ''
  }

  private async format(items: Extraction[], today: string, prefix: string): Promise<string> {
    const lines = await Promise.all(items.map((item) => this.line(item, today)))
    const count = items.length
    return `${prefix}*${count} thing${count === 1 ? '' : 's'}*\n\n${lines.join('\n')}`
  }

  /** Citations come from the stored source message, never from the model. */
  private async line(item: Extraction, today: string): Promise<string> {
    const source = await messageRepository.findById(item.sourceMessageId)
    const course = courseDisplay(item.course ?? item.courseKey) ?? 'Course'
    const when = item.date === today ? 'today' : (item.originalDateText ?? item.date ?? '')
    const at = item.time ? ` ${formatTime12(item.time)}` : ''
    const where = item.venue ? `, ${item.venue}` : ''

    const form =
      source?.type === 'audio' ? 'voice note' : source?.type === 'image' ? 'image' : 'message'
    const stamp = source ? formatStamp(source.timestamp, config.digest.timezone) : ''
    const citation = source ? ` _(${source.senderName ?? 'unknown'}, ${form}, ${stamp})_` : ''

    return `• *${course}* ${item.eventType.replace('_', ' ')} — ${when}${at}${where}${citation}`
  }
}

/** The same event extracted twice still cites two real messages; show it once. */
function dedupe(items: Extraction[]): Extraction[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.sourceMessageId}:${item.eventType}:${item.date}:${item.time}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const digestService = new DigestService()
