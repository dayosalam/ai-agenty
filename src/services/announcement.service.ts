import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { Extraction, Message } from '../models/index.js'
import {
  extractionRepository,
  groupRepository,
  messageRepository,
  notificationRepository,
  pendingRepository,
  userRepository,
} from '../repositories/index.js'
import { courseDisplay, courseKey } from '../utils/courses.js'
import { describeAuthority, outranks } from '../utils/authority.js'
import { formatStamp, formatTime12 } from '../utils/dates.js'
import { conversationService } from './conversation.service.js'
import { deliveryService } from './delivery.service.js'
import { notifierService } from './notifier.service.js'
import { operatorJid } from './operator.js'

/**
 * The instant DM. Every new announcement goes to every student subscribed to that
 * course, within the minute.
 *
 * PRD §8 ruled out dedupe and per-user toggles for the prototype; both are reversed
 * here. Repeats turned out to be the normal case rather than the exception — three
 * classmates mentioning one test produced three identical DMs, which read as a bug —
 * so a repeat now backs the first telling instead of becoming a second one, and
 * whether a student hears it at all is DeliveryService's decision.
 */
export class AnnouncementService {
  async notify(extractions: Extraction[], source: Message): Promise<void> {
    for (const extraction of extractions) {
      // An announcement with no course cannot be routed to anybody. Dropping it in
      // silence is the worst outcome: Peermate heard the thing, stored it, and told
      // nobody — and nobody knows to fix it. Ask the operator instead.
      if (!extraction.courseKey) {
        await this.reportUnroutable(extraction, source)
        continue
      }

      // Three classmates mentioning one test is one test. Whether that is worth a
      // second DM depends on who is speaking — see decide().
      const existing = await extractionRepository.findSimilar(extraction)
      if (existing) {
        const verdict = this.decide(extraction, existing)
        await extractionRepository.addCorroboration(existing.eventId, extraction.sourceMessageId)
        // A fuller telling completes the first one: "test Friday" then "test Friday
        // 10am in LG7" is one test, now with a time and a venue.
        await extractionRepository.enrich(existing.eventId, extraction)

        if (verdict === 'backing') {
          logger.info(
            { courseKey: extraction.courseKey, by: extraction.authority },
            'same event already announced, recorded as corroboration',
          )
          continue
        }
        // 'confirmation': someone more authoritative has now said it, which is worth
        // knowing — the student heard it from a classmate and can now rely on it.
        await this.send(extraction, source, this.formatConfirmation(extraction, source))
        continue
      }

      await this.send(extraction, source, this.format(extraction, source))
    }
  }

  /**
   * Is a repeat worth a second message?
   *
   * Only when it raises the standing of what the student already knows. A lecturer
   * confirming what a classmate said changes whether they can act on it. A second
   * classmate saying the same thing changes nothing, and two identical DMs make
   * Peermate feel broken.
   */
  private decide(incoming: Extraction, existing: Extraction): 'backing' | 'confirmation' {
    return outranks(incoming.authority, existing.authority) ? 'confirmation' : 'backing'
  }

  private async send(extraction: Extraction, source: Message, body: string): Promise<void> {
    const students = await userRepository.subscribedTo(extraction.courseKey!)

    for (const student of students) {
      try {
        // Held, not dropped: the digest covers everything since it last ran, so an
        // announcement a student is not taking right now still reaches them.
        const sent = await deliveryService.send(student, body, {
          kind: 'announcement',
          courseKey: extraction.courseKey,
          eventType: extraction.eventType,
        })
        if (!sent) continue

        // So "where is it?" or "who said that?" a minute later has something to
        // refer to. Without this the student's obvious next question has no subject
        // and gets answered against the whole course instead.
        await conversationService.rememberEvent(student.phone, extraction)

        await notificationRepository.log({
          userPhone: student.phone,
          extractionId: extraction.eventId,
          notificationType: 'instant',
          status: 'sent',
          error: null,
          sentAt: new Date(),
        })
      } catch (error) {
        logger.error({ err: error, phone: student.phone }, 'instant alert failed')
        await notificationRepository.log({
          userPhone: student.phone,
          extractionId: extraction.eventId,
          notificationType: 'instant',
          status: 'failed',
          error: String(error),
          sentAt: new Date(),
        })
      }
    }

    if (students.length === 0) {
      // Extracted correctly and delivered to nobody. Without this it logs as a
      // success and the operator hunts a pipeline bug that does not exist.
      logger.warn(
        { courseKey: extraction.courseKey },
        'announcement extracted but no student is registered for this course',
      )
    } else {
      logger.info(
        { courseKey: extraction.courseKey, students: students.length, by: extraction.authority },
        'alerted',
      )
    }
  }

  /** Someone whose word carries more weight has now said the same thing. */
  private formatConfirmation(extraction: Extraction, source: Message): string {
    const course = courseDisplay(extraction.course ?? extraction.courseKey) ?? 'Your course'
    const event = extraction.eventType.replace('_', ' ')
    const role = describeAuthority(extraction.authority)
    const stamp = formatStamp(source.timestamp, config.digest.timezone)

    const when = [extraction.originalDateText ?? extraction.date, formatTime12(extraction.time)]
      .filter(Boolean)
      .join(' ')
    const where = extraction.venue ? `, ${extraction.venue}` : ''

    return `✅ *Confirmed — ${course} ${event}*${when ? ` — ${when}` : ''}${where}

${source.senderName ?? 'Someone'}${role ? ` (${role})` : ''} has now said the same thing.
_${source.senderName ?? 'unknown'}, ${stamp}_`
  }

  /**
   * Asks the operator which course an announcement belongs to.
   *
   * Happens when a group has no default course and the message does not name one —
   * a group called "Peermate" or "Dept Notices" rather than "CSC 301". The question
   * is stored, not just sent, so it can still be answered after the notification has
   * scrolled away; otherwise the announcement is lost the moment attention moves on.
   */
  private async reportUnroutable(extraction: Extraction, source: Message): Promise<void> {
    const group = await groupRepository.findByJid(source.chatJid)
    const form =
      source.type === 'audio' ? 'voice note' : source.type === 'image' ? 'image' : 'message'
    const heard = [
      extraction.eventType.replace('_', ' '),
      extraction.originalDateText ?? extraction.date,
      formatTime12(extraction.time),
      extraction.venue,
    ]
      .filter(Boolean)
      .join(' · ')

    await pendingRepository.open({
      eventId: extraction.eventId,
      sourceMessageId: extraction.sourceMessageId,
      chatJid: source.chatJid,
      groupName: group?.name ?? null,
      summary: heard,
      status: 'open',
      askedAt: new Date(),
      resolvedAt: null,
      resolvedCourse: null,
    })

    logger.warn(
      { source: source.waMessageId, group: group?.name },
      'announcement had no course, asking the operator',
    )

    const operator = await operatorJid()
    if (!operator) {
      logger.warn('no ADMIN_PHONE set — nobody can answer which course this was')
      return
    }

    const stamp = formatStamp(source.timestamp, config.digest.timezone)
    const body = `❓ I heard something in *${group?.name ?? source.chatJid}* but I don't know which course it's for, so I haven't told anyone yet.

_"${heard}"_
_${source.senderName ?? 'unknown'}, ${form}, ${stamp}_

Which course is this? Reply:
• *MAT 111* — file just this one
• *always MAT 111* — and use that for everything from this group
• *ignore* — skip it`

    try {
      await notifierService.sendText(operator, body)
    } catch (error) {
      logger.error({ err: error }, 'could not ask about unroutable announcement')
    }
  }

  /**
   * Delivers an announcement that was stuck waiting for a course.
   *
   * Called once the operator answers. The extraction row is updated in place rather
   * than appended, because it was never a claim about the world — it was incomplete.
   */
  async deliverResolved(eventId: string, course: string): Promise<number> {
    const extraction = await extractionRepository.findByEventId(eventId)
    if (!extraction) return 0

    const key = courseKey(course)
    await extractionRepository.setCourse(eventId, course, key)

    const source = await messageRepository.findById(extraction.sourceMessageId)
    if (!source) return 0

    const students = await userRepository.subscribedTo(key ?? '')
    await this.notify([{ ...extraction, course, courseKey: key }], source)
    return students.length
  }

  /**
   * The citation is the point. The student never saw the original, so the answer has
   * to carry who said it, in what form, and when — all from the stored row.
   */
  private format(extraction: Extraction, source: Message): string {
    const course = courseDisplay(extraction.course ?? extraction.courseKey) ?? 'Your course'
    const when = [extraction.originalDateText ?? extraction.date, formatTime12(extraction.time)]
      .filter(Boolean)
      .join(' ')
    const where = extraction.venue ? `, ${extraction.venue}` : ''

    const event = extraction.eventType.replace('_', ' ')
    const form =
      source.type === 'audio' ? 'voice note' : source.type === 'image' ? 'image' : 'message'
    const stamp = formatStamp(source.timestamp, config.digest.timezone)
    const role = describeAuthority(extraction.authority)
    const citation = `_${source.senderName ?? 'unknown'}${role ? ` (${role})` : ''}, ${form}, ${stamp}_`

    // Uncertainty has to come first. A confident headline with a hedge bolted on the
    // end still reads as fact — the student has acted on it before reaching the caveat.
    if (extraction.confidence < 0.6) {
      const heard = [when, extraction.venue].filter(Boolean).join(', ')
      return `⚠️ *Possible ${course} ${event}*\n\nI heard ${heard ? `"${heard}"` : 'something about this'}, but I'm not fully certain — worth checking.\n${citation}`
    }

    return `*${course} ${event}*${when ? ` — ${when}` : ''}${where}\n${citation}`
  }
}

export const announcementService = new AnnouncementService()
