import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Course, User } from '../src/models/index.js'

let known: Course[] = []

vi.mock('../src/repositories/index.js', () => ({
  courseRepository: { forKeys: vi.fn(async () => known), find: vi.fn(), enrich: vi.fn() },
  extractionRepository: { forCourses: vi.fn(async () => []) },
  groupRepository: { approved: vi.fn(async () => []) },
  resourceRepository: { forCourse: vi.fn(async () => []) },
  scheduleRepository: { forCourse: vi.fn(async () => []) },
}))

const { courseService } = await import('../src/services/course.service.js')

function course(over: Partial<Course>): Course {
  return {
    courseKey: 'CVE575',
    code: 'CVE 575',
    title: null,
    lecturer: null,
    aliases: [],
    updatedAt: new Date(),
    ...over,
  }
}

const student = { phone: '234', courseKeys: ['CVE575', 'CVE567', 'ABE501'] } as User

beforeEach(() => {
  known = []
})

/**
 * Course matching is on `courseKey` everywhere, and a near-miss returns nothing and
 * raises nothing. Without a registry of titles and lecturers, "what did Dr Bello say?"
 * fails silently rather than visibly — which is the worst way for it to fail.
 */
describe('working out which course they mean', () => {
  it('takes a code over anything else in the sentence', async () => {
    known = [course({ title: 'Structural Analysis' })]
    const hit = await courseService.resolve('any news on ABE 501?', student)
    expect(hit?.courseKey).toBe('ABE501')
    expect(hit?.matchedOn).toBe('code')
  })

  it('resolves a course by its title', async () => {
    known = [course({ title: 'Advanced Structural Analysis' })]
    const hit = await courseService.resolve('when is the structural analysis test?', student)
    expect(hit?.courseKey).toBe('CVE575')
    expect(hit?.matchedOn).toBe('title')
  })

  it('resolves a course by who teaches it', async () => {
    known = [course({ lecturer: 'Dr. Bello' })]
    const hit = await courseService.resolve('what did bello say about the test?', student)
    expect(hit?.courseKey).toBe('CVE575')
    expect(hit?.matchedOn).toBe('lecturer')
  })

  /** "Analysis" is in three titles; one shared word is a coincidence, not a match. */
  it('refuses to match on a single common word', async () => {
    known = [course({ title: 'Advanced Structural Analysis' })]
    expect(await courseService.resolve('can you do an analysis for me?', student)).toBeNull()
  })

  it('asks rather than guessing when two courses fit equally well', async () => {
    known = [
      course({ courseKey: 'CVE575', title: 'Water Resources Engineering' }),
      course({ courseKey: 'CVE567', code: 'CVE 567', title: 'Water Resources Management' }),
    ]
    expect(await courseService.resolve('the water resources one', student)).toBeNull()
  })

  it('never resolves to a course the student does not take', async () => {
    known = [course({ courseKey: 'MTH101', code: 'MTH 101', title: 'Calculus' })]
    expect(await courseService.resolve('when is the MTH 101 test?', student)).toBeNull()
    expect(await courseService.resolve('the calculus one', student)).toBeNull()
  })

  it('does not mistake a short name fragment for the lecturer', async () => {
    known = [course({ lecturer: 'Dr. Bello' })]
    // "bell" is not "bello", and a substring match would have claimed it was.
    expect(await courseService.resolve('did the bell ring yet?', student)).toBeNull()
  })
})
