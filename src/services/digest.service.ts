import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { Extraction, Group, User } from '../models/index.js'
import {
  extractionRepository,
  groupRepository,
  messageRepository,
  notificationRepository,
  resourceRepository,
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

    if (items.length === 0) return this.nothingYet(student, label)

    const today = todayIso(config.digest.timezone)
    return this.format(items, today, `Here's what happened ${label} 👇\n\n`)
  }

  /**
   * The empty answer, which is the one that has to work hardest.
   *
   * "Nothing has come up in CVE 567, CVE 577, CVE 575, ABE 501, WEE 511, CVE 565,
   * ABE 573, CVE 581 this week" is technically true and useless: it lists seven
   * courses Peermate could not have heard anything about, because it is in no group
   * for them, and gives the student no way to tell an empty week from a broken setup.
   *
   * So say what is actually being listened to, name the gap, and offer the next move.
   */
  private async nothingYet(student: User, label: string): Promise<string> {
    const live = await groupRepository.approved()
    const covered = new Set(live.map((group) => group.defaultCourseKey).filter(Boolean))

    // A group approved without a course is still being read — the course is worked
    // out per message — so it can carry any of them. Counting only course-keyed
    // groups told a student "I'm not reading any group" a minute after telling them
    // it had started reading one, which is the kind of contradiction they can check.
    const open = live.filter((group) => !group.defaultCourseKey)

    const watching = student.courseKeys.filter((key) => covered.has(key))
    const unheard = student.courseKeys.filter((key) => !covered.has(key))

    if (watching.length === 0 && open.length === 0) {
      const waiting = await groupRepository.pending()
      const pendingNote = waiting.length
        ? `\n\n*${waiting[0]!.name ?? 'A group'}* is waiting to be approved — once it is, I'll start picking things up from it.`
        : `\n\nAdd me to one of your course groups and tell me which course it's for.`
      return `Nothing yet — I'm not reading any group for your courses, so there's nothing I *could* have heard.${pendingNote}`
    }

    if (watching.length === 0) return this.nothingInOpenGroups(student, label, open)

    // Distinguish an empty window from an empty archive: "nothing this week" reads
    // very differently when there are ten things from before it.
    const everything = dedupe(await extractionRepository.forCourses(watching, new Date(0)))
    const files = (
      await Promise.all(watching.map((key) => resourceRepository.forCourse(key)))
    ).flat()

    const courses = watching.map(courseDisplay).join(', ')
    // "No announcements, no files" is only sayable when both are true — claiming it
    // beside a line counting two files is the kind of contradiction that makes a
    // student stop believing the rest of the message.
    const heading =
      everything.length > 0
        ? `Nothing in ${courses} ${label}.`
        : files.length > 0
          ? `Nothing has been announced in ${courses} since I joined.`
          : `Nothing at all in ${courses} since I joined — no announcements, no files.`

    const holding: string[] = []
    if (everything.length > 0) {
      holding.push(
        `I do have *${everything.length}* older thing${everything.length === 1 ? '' : 's'} on file.`,
      )
    }
    if (files.length > 0) {
      holding.push(`*${files.length}* file${files.length === 1 ? '' : 's'} people shared.`)
    }

    const gap = unheard.length
      ? `\n\n⚠️ I'm in no group for ${unheard.map(courseDisplay).join(', ')}, so I'd never hear about those.`
      : ''

    const next =
      everything.length > 0
        ? `\n\nWant me to look further back, or check one course on its own?`
        : `\n\nAsk me again once something's been posted — or say *${courseDisplay(watching[0]!)} resources* to see what files are there.`

    return `${heading}${holding.length ? `\n\n${holding.join(' ')}` : ''}${gap}${next}`
  }

  /**
   * Nothing yet, but from a group with no course pinned to it.
   *
   * Worth its own answer: the honest report is that Peermate is listening and the
   * group has been quiet, not that it is deaf. Which courses it will end up covering
   * is not knowable in advance — it depends on what people say in there.
   */
  private async nothingInOpenGroups(student: User, label: string, open: Group[]): Promise<string> {
    const names = open.map((group) => `*${group.name ?? 'a group'}*`).join(', ')
    const older = dedupe(await extractionRepository.forCourses(student.courseKeys, new Date(0)))

    const holding = older.length
      ? `\n\nI do have *${older.length}* older thing${older.length === 1 ? '' : 's'} on file — ask me to look further back.`
      : ''

    return `Nothing ${label} — I'm reading ${names} and ${open.length === 1 ? 'it has' : "they've"} been quiet.

No single course is set for ${open.length === 1 ? 'it' : 'them'}, so I work out which course each message is about as it comes in.${holding}`
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
