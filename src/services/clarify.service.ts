import { config } from '../config.js'
import type { User } from '../models/index.js'
import { extractionRepository, scheduleRepository } from '../repositories/index.js'
import { courseDisplay } from '../utils/courses.js'
import { formatTime12, zonedDay } from '../utils/dates.js'

/**
 * A bare event noun, with no course attached to it.
 *
 * "When is the lecture?" is not a question Peermate can answer for somebody taking
 * eight courses — and it is the single most common way students phrase it, because in
 * their own head there is only one lecture they care about.
 */
const BARE_EVENT =
  /\b(the|my|our|a)\s+(lecture|class|test|exam|tutorial|practical|assignment|quiz|lesson)\b|^(lecture|class|test|exam|tutorial)\b/i

/** A code, a title or a lecturer already in the sentence means it is not bare. */
const NAMES_SOMETHING = /\b[A-Za-z]{2,4}\s?\d{3,4}\b/

/**
 * Asks which one, rather than answering about the wrong one.
 *
 * The alternative is picking — by recency, by first course, by whatever retrieval
 * ranked highest — and a confident answer about the wrong lecture is worse than a
 * question, because the student has no way to tell it was a guess.
 *
 * The question is built from real candidates. "Which course?" listing eight codes is
 * barely better than guessing; "you have two lectures today, CVE 575 at 8am and
 * ABE 501 at noon — which one?" is a question somebody can actually answer.
 */
export class ClarifyService {
  /** Returns the question to ask, or null when the request is specific enough. */
  async ask(
    user: User,
    text: string,
    resolved: string | null,
    now = new Date(),
  ): Promise<string | null> {
    if (resolved) return null
    if (user.courseKeys.length < 2) return null
    if (NAMES_SOMETHING.test(text)) return null

    const match = BARE_EVENT.exec(text)
    if (!match) return null

    const noun = (match[2] ?? match[3] ?? 'one').toLowerCase()
    const candidates = await this.candidatesFor(user, noun, now)

    // Only interrupt when the ambiguity is real and nameable. With nothing scheduled
    // to point at, "which test?" is a worse move than searching — retrieval covers
    // every course they take, and the answer names the course it found.
    if (candidates.length < 2) return null
    return this.byCandidate(noun, candidates)
  }

  /**
   * What could plausibly be meant, from their timetable and from what was announced.
   *
   * Limited to today and tomorrow on purpose: "the lecture" almost always means an
   * imminent one, and offering a list spanning the whole semester turns a clarifying
   * question into a worse version of the problem.
   */
  private async candidatesFor(
    user: User,
    noun: string,
    now: Date,
  ): Promise<Array<{ courseKey: string | null; when: string; time: string | null }>> {
    const kinds = KIND_WORDS[noun] ?? [noun]
    const found: Array<{ courseKey: string | null; when: string; time: string | null }> = []

    const schedule = await scheduleRepository.forStudent(user.phone)
    for (const offset of [0, 1]) {
      const day = zonedDay(new Date(now.getTime() + offset * 86_400_000), config.digest.timezone)
      const weekday = new Date(`${day.iso}T12:00:00Z`).getUTCDay()
      const label = offset === 0 ? 'today' : 'tomorrow'

      for (const entry of schedule) {
        if (!kinds.includes(entry.kind)) continue
        if (entry.date !== day.iso && entry.weekday !== weekday) continue
        found.push({ courseKey: entry.courseKey, when: label, time: entry.time })
      }

      for (const item of await extractionRepository.dueOn(user.courseKeys, day.iso)) {
        if (!kinds.includes(item.eventType)) continue
        found.push({ courseKey: item.courseKey, when: label, time: item.time })
      }
    }

    return dedupe(found)
  }

  private byCandidate(
    noun: string,
    candidates: Array<{ courseKey: string | null; when: string; time: string | null }>,
  ): string {
    const lines = candidates
      .slice(0, 6)
      .map(
        (candidate) =>
          `• *${courseDisplay(candidate.courseKey) ?? 'unknown course'}* — ${candidate.when}${candidate.time ? ` at ${formatTime12(candidate.time)}` : ''}`,
      )
    return `You've got ${candidates.length} ${noun}s coming up:\n\n${lines.join('\n')}\n\nWhich one do you mean?`
  }
}

/** The words students use, mapped onto the kinds actually stored. */
const KIND_WORDS: Record<string, string[]> = {
  lecture: ['lecture'],
  class: ['lecture', 'tutorial', 'practical'],
  lesson: ['lecture'],
  test: ['test'],
  quiz: ['test'],
  exam: ['exam'],
  tutorial: ['tutorial'],
  practical: ['practical'],
  assignment: ['assignment', 'deadline'],
}

function dedupe<T extends { courseKey: string | null; when: string; time: string | null }>(
  items: T[],
): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.courseKey}:${item.when}:${item.time}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const clarifyService = new ClarifyService()
