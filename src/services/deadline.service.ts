import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { Extraction, Resource, User } from '../models/index.js'
import {
  extractionRepository,
  notificationRepository,
  resourceRepository,
  userRepository,
} from '../repositories/index.js'
import { courseDisplay } from '../utils/courses.js'
import { formatTime12, todayIso } from '../utils/dates.js'
import { deliveryService } from './delivery.service.js'
import { notifierService } from './notifier.service.js'

const DUE_TODAY = new Set(['assignment', 'deadline', 'test'])

export interface DeadlineOptions {
  /** After the morning digest has already named everything due today. */
  attachmentsOnly?: boolean
}

/**
 * The unprompted moment: the deadline warning arrives with the brief already
 * attached. She never asked for the file.
 *
 * This is the join between announcements and the resource library — the only place
 * the two halves of the store meet, and the reason both exist.
 */
export class DeadlineService {
  async runForAll(options: DeadlineOptions = {}): Promise<void> {
    const today = todayIso(config.digest.timezone)
    const students = await userRepository.allRegistered()
    logger.info({ students: students.length, today }, 'running deadline warnings')

    for (const student of students) {
      try {
        await this.runFor(student, today, options)
      } catch (error) {
        logger.error({ err: error, phone: student.phone }, 'deadline warning failed')
      }
    }
  }

  async runFor(student: User, today: string, options: DeadlineOptions = {}): Promise<void> {
    if (student.courseKeys.length === 0) return

    const due = (await extractionRepository.dueOn(student.courseKeys, today)).filter((item) =>
      DUE_TODAY.has(item.eventType),
    )

    // Start of today in the digest timezone, so a second run on the same day is a
    // no-op but tomorrow's warning still goes out.
    const startOfToday = new Date(`${today}T00:00:00`)

    for (const item of due) {
      if (
        await notificationRepository.alreadySent(
          student.phone,
          item.eventId,
          'deadline_warning',
          startOfToday,
        )
      ) {
        logger.debug({ phone: student.phone, event: item.eventId }, 'already warned today')
        continue
      }

      const brief = await this.findBrief(item)

      // After the digest, the deadline is already listed — repeating the headline
      // seconds later reads as a duplicate. Send only what the digest cannot: the
      // file itself.
      if (options.attachmentsOnly && !brief) continue

      const sent = await deliveryService.send(
        student,
        options.attachmentsOnly ? this.attachmentIntro(item) : this.format(item, brief),
        {
          kind: 'deadline',
          courseKey: item.courseKey,
          eventType: item.eventType,
          eventId: item.eventId,
        },
      )
      // No warning, no attachment — a file arriving with no context is worse than
      // the silence the student asked for.
      if (!sent) continue

      if (brief) {
        try {
          await notifierService.sendFile(
            student.jid,
            brief.mediaKey,
            brief.fileName,
            brief.mimeType ?? undefined,
          )
        } catch (error) {
          // The warning is the point; a missing file must not suppress it.
          logger.error({ err: error, mediaKey: brief.mediaKey }, 'could not attach brief')
        }
      }

      await notificationRepository.log({
        userPhone: student.phone,
        extractionId: item.eventId,
        notificationType: 'deadline_warning',
        status: 'sent',
        error: null,
        sentAt: new Date(),
      })
    }

    if (due.length > 0) {
      logger.info({ phone: student.phone, count: due.length }, 'deadline warnings sent')
    }
  }

  /**
   * The brief that belongs to *this* deadline.
   *
   * A course can have several assignments, and attaching the most recent one by
   * default means confidently sending the wrong paper. Score candidates on words
   * shared with the announcement; when nothing clearly matches, send the warning
   * with no attachment rather than a misleading one.
   */
  private async findBrief(item: Extraction): Promise<Resource | null> {
    if (!item.courseKey) return null
    const briefs = (await resourceRepository.forCourse(item.courseKey)).filter(
      (resource) => resource.docType === 'assignment',
    )
    if (briefs.length === 0) return null
    if (briefs.length === 1) return briefs[0]!

    const words = tokens(
      [item.originalDateText, item.venue, item.eventType, item.date].filter(Boolean).join(' '),
    )
    let best: Resource | null = null
    let bestScore = 0

    for (const brief of briefs) {
      const haystack = tokens(brief.fileName)
      const score = [...words].filter((word) => haystack.has(word)).length
      if (score > bestScore) {
        best = brief
        bestScore = score
      }
    }

    // Ambiguous: several briefs and nothing distinguishes them. Silence beats wrong.
    if (bestScore === 0) {
      logger.info(
        { courseKey: item.courseKey, candidates: briefs.length },
        'several briefs and no clear match, sending warning without attachment',
      )
      return null
    }
    return best
  }

  /** Follows the digest, which already said what is due. */
  private attachmentIntro(item: Extraction): string {
    const course = courseDisplay(item.course ?? item.courseKey) ?? 'Your course'
    return `Here's the *${course}* brief 👇`
  }

  private format(item: Extraction, brief: Resource | null): string {
    const course = courseDisplay(item.course ?? item.courseKey) ?? 'Course'
    const at = item.time ? ` ${formatTime12(item.time)}` : ''
    const where = item.venue ? `, ${item.venue}` : ''
    const tail = brief ? "\n\nHere's the brief 👇" : ''
    return `⏰ *${course} ${item.eventType.replace('_', ' ')} — today${at}*${where}${tail}`
  }
}

/** Words worth matching on — numbers and names, not "the" and "of". */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2),
  )
}

export const deadlineService = new DeadlineService()
