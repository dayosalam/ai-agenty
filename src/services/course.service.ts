import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { Course, ScheduleEntry, User } from '../models/index.js'
import {
  courseRepository,
  extractionRepository,
  groupRepository,
  resourceRepository,
  scheduleRepository,
} from '../repositories/index.js'
import { courseDisplay, courseKey, parseCourseList } from '../utils/courses.js'
import { formatTime12 } from '../utils/dates.js'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Words that carry no identity, so a title match on them means nothing. */
const NOISE = new Set([
  'the',
  'and',
  'of',
  'for',
  'to',
  'in',
  'a',
  'an',
  'on',
  'with',
  'course',
  'class',
  'my',
  'me',
  'about',
  'tell',
  'what',
  'is',
  'are',
  'do',
  'i',
  'you',
  'it',
  'that',
  'this',
  'lecture',
  'test',
])

export interface Resolution {
  courseKey: string
  /** Why it matched, so a reply can say "I took that to mean…" rather than assume. */
  matchedOn: 'code' | 'title' | 'alias' | 'lecturer'
  matched: string
}

/**
 * Which course somebody means.
 *
 * Students do not say "CVE 575". They say "structural analysis", or "Dr Bello's
 * course". Matching is on `courseKey` everywhere, and a near-miss returns nothing and
 * raises nothing — so without a registry of titles, lecturers and aliases those
 * questions silently fail rather than visibly fail.
 *
 * Only ever resolves to a course the student actually takes. Guessing outside that
 * set produces a confident answer about somebody else's subject.
 */
export class CourseService {
  async learn(
    courses: Array<{
      courseKey: string
      code: string
      title: string | null
      lecturer: string | null
    }>,
  ): Promise<void> {
    for (const course of courses) {
      await courseRepository.enrich(course.courseKey, {
        code: course.code,
        title: course.title,
        lecturer: course.lecturer,
        aliases: course.title ? [course.title.toLowerCase()] : [],
      })
    }
    if (courses.length > 0) {
      logger.info({ courses: courses.map((course) => course.courseKey) }, 'course details learned')
    }
  }

  /** A code in the text beats everything; it is the one form that cannot be ambiguous. */
  async resolve(text: string, user: User): Promise<Resolution | null> {
    const [named] = parseCourseList(text).filter((key) => user.courseKeys.includes(key))
    if (named)
      return { courseKey: named, matchedOn: 'code', matched: courseDisplay(named) ?? named }

    // Filtered here as well as in the query. The guarantee is stated on this method,
    // so it holds locally rather than depending on every caller's query being right —
    // resolving to a course they do not take answers confidently about the wrong one.
    const known = (await courseRepository.forKeys(user.courseKeys)).filter((course) =>
      user.courseKeys.includes(course.courseKey),
    )
    const lower = text.toLowerCase()

    for (const course of known) {
      if (course.lecturer && mentionsName(lower, course.lecturer)) {
        return { courseKey: course.courseKey, matchedOn: 'lecturer', matched: course.lecturer }
      }
    }

    const scored = known
      .map((course) => ({ course, hit: bestPhrase(lower, course) }))
      .filter((entry) => entry.hit !== null)
      .sort((a, b) => b.hit!.score - a.hit!.score)

    const [best, runnerUp] = scored
    if (!best) return null
    // A tie is a real ambiguity — two courses matching equally well means the words
    // chosen do not distinguish them, and picking one would be a coin flip.
    if (runnerUp && runnerUp.hit!.score === best.hit!.score) return null

    return {
      courseKey: best.course.courseKey,
      matchedOn: best.hit!.source,
      matched: best.hit!.text,
    }
  }

  /** The stored record, for callers that want the title rather than the code. */
  async find(key: string): Promise<Course | null> {
    return courseRepository.find(key)
  }

  /**
   * Everything Peermate knows about one course, in one message.
   *
   * The point is coverage, not trivia: a student asking about a course usually wants
   * to know whether Peermate is even watching it, and what is coming up.
   */
  async rundown(user: User, key: string): Promise<string> {
    const course = await courseRepository.find(key)
    const display = course?.code ?? courseDisplay(key) ?? key

    const [groups, schedule, announcements, files] = await Promise.all([
      groupRepository.approved(),
      scheduleRepository.forCourse(user.phone, key),
      extractionRepository.forCourses([key], new Date(Date.now() - 30 * DAY_MS)),
      resourceRepository.forCourse(key),
    ])

    const connected = groups.some((group) => group.defaultCourseKey === key)
    const lines: string[] = [`*${display}*${course?.title ? ` — ${course.title}` : ''}`]

    if (course?.lecturer) lines.push(`Taught by ${course.lecturer}.`)

    lines.push(
      connected
        ? `✅ I'm reading the group for this.`
        : `⚠️ I'm not in a group for this, so I won't hear anything about it.`,
    )

    const weekly = schedule.filter((entry) => entry.weekday !== null)
    if (weekly.length > 0) lines.push('', `*Your timetable*`, ...weekly.map(describeWeekly))

    const next = nextDated(schedule)
    if (next) {
      lines.push(
        '',
        `*Next ${next.kind}:* ${next.date}${next.time ? ` at ${formatTime12(next.time)}` : ''}${next.venue ? `, ${next.venue}` : ''}`,
      )
    }

    const holdings: string[] = []
    if (announcements.length > 0) {
      holdings.push(
        `*${announcements.length}* announcement${announcements.length === 1 ? '' : 's'} in the last month`,
      )
    }
    if (files.length > 0) holdings.push(`*${files.length}* file${files.length === 1 ? '' : 's'}`)

    if (holdings.length > 0) {
      lines.push('', `I have ${holdings.join(' and ')}.`)
      lines.push(
        announcements.length > 0
          ? `Ask me *what's happening in ${display}* or say *${display} resources*.`
          : `Say *${display} resources* and I'll send them.`,
      )
    } else if (connected) {
      lines.push('', `Nothing has come up in it yet since I joined.`)
    }

    return lines.join('\n')
  }
}

/**
 * A title match has to be a phrase, not a stray word.
 *
 * "Analysis" appears in three course titles; "structural analysis" appears in one.
 * Scoring on the number of meaningful words shared is what keeps a one-word
 * coincidence from resolving to the wrong subject.
 */
function bestPhrase(
  lower: string,
  course: Course,
): { score: number; text: string; source: 'title' | 'alias' } | null {
  const candidates: Array<{ text: string; source: 'title' | 'alias' }> = [
    ...(course.title ? [{ text: course.title, source: 'title' as const }] : []),
    ...course.aliases.map((alias) => ({ text: alias, source: 'alias' as const })),
  ]

  let best: { score: number; text: string; source: 'title' | 'alias' } | null = null
  for (const candidate of candidates) {
    const words = candidate.text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !NOISE.has(word))
    if (words.length === 0) continue

    const hits = words.filter((word) => lower.includes(word)).length
    if (hits === 0) continue
    // One word out of four is a coincidence; the whole phrase is a match.
    if (hits < Math.min(2, words.length)) continue

    const score = hits / words.length
    if (!best || score > best.score)
      best = { score, text: candidate.text, source: candidate.source }
  }
  return best
}

/** "Dr. Bello" and "bello" are the same person; "bell" is not. */
function mentionsName(lower: string, lecturer: string): boolean {
  const parts = lecturer
    .toLowerCase()
    .replace(/\b(dr|prof|professor|mr|mrs|ms|engr|sir)\b\.?/g, '')
    .split(/[^a-z]+/)
    .filter((part) => part.length > 2)
  return parts.some((part) => new RegExp(`\\b${part}\\b`).test(lower))
}

function describeWeekly(entry: ScheduleEntry): string {
  const day = entry.weekday === null ? '' : WEEKDAYS[entry.weekday]!
  const at = entry.time ? ` ${formatTime12(entry.time)}` : ''
  const where = entry.venue ? `, ${entry.venue}` : ''
  return `• ${day}${at}${where} _(${entry.kind})_`
}

function nextDated(schedule: ScheduleEntry[]): ScheduleEntry | null {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: config.digest.timezone })
  return (
    schedule
      .filter((entry) => entry.date !== null && entry.date >= today)
      .sort((a, b) => a.date!.localeCompare(b.date!))[0] ?? null
  )
}

export const courseService = new CourseService()
