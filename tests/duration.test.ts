import { describe, expect, it } from 'vitest'
import { describeResume, parsePause } from '../src/utils/duration.js'

const LAGOS = 'Africa/Lagos'

/** A Wednesday, mid-afternoon in Lagos. */
const WEDNESDAY = new Date('2026-09-16T14:00:00+01:00')

describe('how long "pause" means', () => {
  it('counts hours, days and weeks', () => {
    const hours = parsePause('pause for 3 hours', LAGOS, WEDNESDAY).until!
    expect(hours.getTime() - WEDNESDAY.getTime()).toBe(3 * 60 * 60 * 1000)

    const days = parsePause('pause for 2 days', LAGOS, WEDNESDAY).until!
    expect(days.getTime() - WEDNESDAY.getTime()).toBe(2 * 24 * 60 * 60 * 1000)

    const week = parsePause('mute for a week', LAGOS, WEDNESDAY).until!
    expect(week.getTime() - WEDNESDAY.getTime()).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('resumes at the start of the named day, not the moment they asked', () => {
    const monday = parsePause('pause until Monday', LAGOS, WEDNESDAY).until!
    expect(monday.toISOString()).toBe('2026-09-20T23:00:00.000Z')
  })

  it('reads "the weekend" as "until Monday"', () => {
    expect(parsePause('no alerts this weekend', LAGOS, WEDNESDAY).until!.toISOString()).toBe(
      parsePause('pause until monday', LAGOS, WEDNESDAY).until!.toISOString(),
    )
  })

  it('means the next one when they name today', () => {
    const wednesday = parsePause('pause until Wednesday', LAGOS, WEDNESDAY).until!
    // A pause that ended the instant it started would be no pause at all.
    expect(wednesday.getTime() - WEDNESDAY.getTime()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000)
  })

  /**
   * The case this exists for: inventing an endpoint for "until after exams" resumes
   * at a moment the student never agreed to, and they find out by being messaged.
   */
  it('gives no end date to wording it cannot resolve', () => {
    expect(parsePause('pause until after exams', LAGOS, WEDNESDAY).until).toBeNull()
    expect(parsePause('stop messaging me', LAGOS, WEDNESDAY).until).toBeNull()
    expect(parsePause('pause until I say so', LAGOS, WEDNESDAY).until).toBeNull()
  })

  it('describes when it will be back in words a student would use', () => {
    const monday = parsePause('pause until Monday', LAGOS, WEDNESDAY).until!
    expect(describeResume(monday, LAGOS)).toMatch(/Monday/)
  })
})
