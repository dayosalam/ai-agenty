import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { EventType, User } from '../models/index.js'
import { conversationRepository } from '../repositories/index.js'
import { isQuietHour } from '../utils/quiet.js'
import { notifierService } from './notifier.service.js'

/** Things worth interrupting someone for. Everything else can wait for the digest. */
const URGENT: EventType[] = ['test', 'deadline', 'venue_change', 'assignment']

export interface Unsolicited {
  kind: 'announcement' | 'resource' | 'digest' | 'deadline'
  courseKey?: string | null
  eventType?: EventType | null
}

interface Batch {
  jid: string
  bodies: string[]
  /** When the first held item arrived, so a long conversation cannot defer forever. */
  since: number
  timer: NodeJS.Timeout
}

/**
 * Everything Peermate sends that the student did not just ask for goes through here.
 *
 * Two separate problems, one gate. The first is consent: a student who said "pause
 * until Monday" or "only urgent" has to be obeyed everywhere, and a rule enforced in
 * three services is a rule that will be missed in the fourth. The second is timing —
 * an alert landing in the middle of a conversation reads as an answer to the question
 * they just asked, which is how a bot ends up appearing to say something it did not.
 *
 * Nothing is dropped here. Held announcements are still stored, and the digest covers
 * everything since it last ran, so a pause defers rather than deletes.
 */
export class DeliveryService {
  private readonly deferred = new Map<string, Batch>()

  /** Returns false when the message was held rather than sent. */
  async send(student: User, body: string, about: Unsolicited): Promise<boolean> {
    const held = this.heldReason(student, about)
    if (held) {
      logger.info({ phone: student.phone, kind: about.kind, held }, 'not sending')
      return false
    }

    if (
      config.delivery.enabled &&
      about.kind !== 'digest' &&
      (await this.midConversation(student.phone))
    ) {
      this.defer(student.phone, student.jid, body)
      return false
    }

    await notifierService.sendText(student.jid, body)
    return true
  }

  /** Why this student is not being messaged right now, or null when they can be. */
  private heldReason(student: User, about: Unsolicited): string | null {
    if (student.paused) return 'paused indefinitely'
    if (student.pausedUntil && student.pausedUntil.getTime() > Date.now()) return 'paused'

    if (about.kind === 'digest') return student.digestPaused ? 'digest turned off' : null

    if (about.courseKey && student.mutedCourseKeys.includes(about.courseKey)) return 'course muted'
    if (isQuietHour(student)) return 'quiet hours'

    if (student.alertLevel === 'urgent') {
      // A new file is never urgent, and an announcement with no type cannot be
      // judged — treat both as something the morning digest can carry.
      if (about.kind !== 'announcement') return 'urgent alerts only'
      if (!about.eventType || !URGENT.includes(about.eventType)) return 'urgent alerts only'
    }

    return null
  }

  private async midConversation(phone: string): Promise<boolean> {
    const conversation = await conversationRepository.find(phone)
    if (!conversation) return false
    return Date.now() - conversation.updatedAt.getTime() < config.delivery.conversationActiveMs
  }

  /**
   * Waits for the exchange to finish, then sends what arrived while they were typing.
   *
   * Batched, because a lecturer posting a timetable produces several announcements at
   * once and four separate "by the way" messages is worse than the interruption it
   * was avoiding.
   */
  private defer(phone: string, jid: string, body: string): void {
    const existing = this.deferred.get(phone)
    if (existing) {
      clearTimeout(existing.timer)
      existing.bodies.push(body)
      existing.timer = this.schedule(phone)
      return
    }

    this.deferred.set(phone, {
      jid,
      bodies: [body],
      since: Date.now(),
      timer: this.schedule(phone),
    })
    logger.info({ phone }, 'mid-conversation, holding alert')
  }

  private schedule(phone: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      void this.flush(phone).catch((error) =>
        logger.error({ err: error, phone }, 'deferred alert failed'),
      )
    }, config.delivery.deferMs)
    // A pending courtesy must never be the reason the process will not exit.
    timer.unref?.()
    return timer
  }

  private async flush(phone: string): Promise<void> {
    const batch = this.deferred.get(phone)
    if (!batch || batch.bodies.length === 0) {
      this.deferred.delete(phone)
      return
    }
    clearTimeout(batch.timer)

    // Still talking. Waiting for the gap is the whole point, but a conversation that
    // runs for ten minutes must not bury a test alert — past the cap it goes out.
    if (
      Date.now() - batch.since < config.delivery.maxDeferMs &&
      (await this.midConversation(phone))
    ) {
      batch.timer = this.schedule(phone)
      return
    }

    this.deferred.delete(phone)

    // Said once, ahead of the batch: without it the alert still reads as a late
    // answer to whatever they were asking a minute ago.
    const lead =
      batch.bodies.length === 1
        ? 'One thing came in while we were talking 👇'
        : `${batch.bodies.length} things came in while we were talking 👇`

    await notifierService.sendText(batch.jid, `${lead}\n\n${batch.bodies.join('\n\n———\n\n')}`)
  }

  /** Sends everything pending immediately, so a shutdown loses nothing. */
  async flushAll(): Promise<void> {
    for (const [phone, batch] of [...this.deferred]) {
      // Force it out: on the way down there is no later.
      batch.since = 0
      await this.flush(phone).catch((error) =>
        logger.error({ err: error, phone }, 'could not flush deferred alerts'),
      )
    }
  }

  /**
   * Lifts a pause whose end has passed.
   *
   * Checked on read rather than swept on a timer: a pause that expires while the
   * process is down must still be over when it comes back up.
   */
  static expired(student: User): boolean {
    return (
      !student.paused && student.pausedUntil !== null && student.pausedUntil.getTime() <= Date.now()
    )
  }

  /** What a student is currently being spared, for `settings` to read back. */
  static describeHolds(student: User): string[] {
    const holds: string[] = []
    if (student.paused) holds.push('Everything is paused — send *resume* to start again.')
    else if (student.pausedUntil && student.pausedUntil.getTime() > Date.now()) {
      holds.push(
        `Paused until ${student.pausedUntil.toLocaleString('en-GB', {
          timeZone: config.digest.timezone,
          weekday: 'long',
          day: 'numeric',
          month: 'short',
        })}.`,
      )
    }
    if (student.digestPaused)
      holds.push('Morning digest is off — send *digest on* to bring it back.')
    if (student.alertLevel === 'urgent')
      holds.push('Only urgent alerts — tests, deadlines and venue changes.')
    return holds
  }
}

export const deliveryService = new DeliveryService()
