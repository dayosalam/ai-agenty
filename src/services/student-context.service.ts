import { config } from '../config.js'
import type { User } from '../models/index.js'
import { courseRepository, groupRepository, scheduleRepository } from '../repositories/index.js'
import { courseDisplay } from '../utils/courses.js'
import { formatTime12, zonedDay } from '../utils/dates.js'

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Who the student is, in the few lines a model needs to answer as though it knew them.
 *
 * Retrieval alone cannot answer "when is my lecture?" or "who teaches this?" — the
 * answer is not in any group message, it is in the student's own record. Without this
 * block the model has a pile of quotations and no idea whose they are, so it either
 * refuses a question it could answer or invents the missing half.
 *
 * Deliberately short. This is prepended to every answered question, so it has to earn
 * its tokens: what they take, what is on today, what is next, and which courses
 * Peermate cannot hear about at all.
 */
export class StudentContextService {
  async describe(user: User, now = new Date()): Promise<string> {
    const today = zonedDay(now, config.digest.timezone)
    const weekday = new Date(`${today.iso}T12:00:00Z`).getUTCDay()

    const [courses, groups, schedule] = await Promise.all([
      courseRepository.forKeys(user.courseKeys),
      groupRepository.approved(),
      scheduleRepository.forStudent(user.phone),
    ])

    const known = new Map(courses.map((course) => [course.courseKey, course]))
    const covered = new Set(groups.map((group) => group.defaultCourseKey).filter(Boolean))

    const lines: string[] = [
      `The student is ${user.displayName ?? 'a student'}. Today is ${WEEKDAYS[weekday]} ${today.iso} in ${config.digest.timezone}.`,
    ]

    const taking = user.courseKeys.map((key) => {
      const course = known.get(key)
      const extra = [course?.title, course?.lecturer].filter(Boolean).join(', ')
      return extra ? `${courseDisplay(key)} (${extra})` : (courseDisplay(key) ?? key)
    })
    if (taking.length > 0) lines.push(`They take: ${taking.join('; ')}.`)

    // Naming the gap matters as much as naming the coverage: a question about an
    // uncovered course has no answer, and saying why beats an empty search result.
    const unheard = user.courseKeys.filter((key) => !covered.has(key))
    if (unheard.length > 0) {
      lines.push(
        `Peermate is in NO group for ${unheard.map(courseDisplay).join(', ')} — it cannot have heard anything about those.`,
      )
    }

    const todays = schedule
      .filter((entry) => entry.date === today.iso || entry.weekday === weekday)
      .sort((a, b) => (a.time ?? '99:99').localeCompare(b.time ?? '99:99'))
    if (todays.length > 0) {
      lines.push(
        `On their own timetable today: ${todays
          .map(
            (entry) =>
              `${courseDisplay(entry.courseKey) ?? '?'} ${entry.kind}${entry.time ? ` ${formatTime12(entry.time)}` : ''}${entry.venue ? ` in ${entry.venue}` : ''}`,
          )
          .join('; ')}.`,
      )
    }

    const next = schedule
      .filter((entry) => entry.date !== null && entry.date >= today.iso)
      .sort((a, b) => a.date!.localeCompare(b.date!))[0]
    if (next) {
      lines.push(
        `Their next dated item: ${courseDisplay(next.courseKey) ?? '?'} ${next.kind} on ${next.date}${next.time ? ` at ${formatTime12(next.time)}` : ''}.`,
      )
    }

    return lines.join('\n')
  }
}

export const studentContextService = new StudentContextService()
