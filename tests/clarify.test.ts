import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Extraction, ScheduleEntry, User } from '../src/models/index.js'

let schedule: ScheduleEntry[] = []
let due: Extraction[] = []

vi.mock('../src/repositories/index.js', () => ({
  scheduleRepository: { forStudent: vi.fn(async () => schedule) },
  extractionRepository: {
    dueOn: vi.fn(async (_keys: string[], date: string) => due.filter((d) => d.date === date)),
  },
}))

const { clarifyService } = await import('../src/services/clarify.service.js')

/** A Wednesday. */
const WED = new Date('2026-09-16T07:00:00+01:00')
const student = { phone: '234', courseKeys: ['CVE575', 'ABE501', 'WEE511'] } as User

function lecture(courseKey: string, time: string): ScheduleEntry {
  return {
    phone: '234',
    course: courseKey,
    courseKey,
    kind: 'lecture',
    date: null,
    weekday: 3,
    time,
    venue: null,
    sourceMessageId: 'img',
    createdAt: new Date(),
  }
}

const ask = (text: string, resolved: string | null = null): Promise<string | null> =>
  clarifyService.ask(student, text, resolved, WED)

beforeEach(() => {
  schedule = []
  due = []
})

/**
 * "When is the lecture?" from somebody taking eight courses. The alternative to asking
 * is picking — by recency, by first course, by whatever retrieval ranked highest — and
 * a confident answer about the wrong lecture cannot be told from a right one.
 */
describe('asking which one they mean', () => {
  it('asks when several fit, and names them', async () => {
    schedule = [lecture('CVE575', '08:00'), lecture('ABE501', '12:00')]

    const question = await ask('when is the lecture?')
    expect(question).toMatch(/2 lectures/)
    expect(question).toMatch(/CVE 575.*8am/s)
    expect(question).toMatch(/ABE 501.*12pm/s)
    expect(question).toMatch(/Which one/i)
  })

  it('says nothing when only one fits', async () => {
    schedule = [lecture('CVE575', '08:00')]
    expect(await ask('when is the lecture?')).toBeNull()
  })

  /**
   * With nothing scheduled to point at, "which test?" is a worse move than searching:
   * retrieval already covers every course they take and names the one it found.
   */
  it('stays out of the way when it has nothing concrete to offer', async () => {
    expect(await ask('when is the test?')).toBeNull()
  })

  it('leaves a question that already names a course alone', async () => {
    schedule = [lecture('CVE575', '08:00'), lecture('ABE501', '12:00')]
    expect(await ask('when is the CVE 575 lecture?')).toBeNull()
    expect(await ask('when is the lecture?', 'CVE575')).toBeNull()
  })

  it('never asks somebody who takes one course', async () => {
    schedule = [lecture('CVE575', '08:00'), lecture('ABE501', '12:00')]
    const single = { phone: '234', courseKeys: ['CVE575'] } as User
    expect(await clarifyService.ask(single, 'when is the lecture?', null, WED)).toBeNull()
  })

  it('counts what a group announced alongside their own timetable', async () => {
    schedule = [lecture('CVE575', '08:00')]
    due = [
      {
        courseKey: 'ABE501',
        eventType: 'lecture',
        date: '2026-09-16',
        time: '14:00',
      } as Extraction,
    ]

    expect(await ask('when is the lecture?')).toMatch(/2 lectures/)
  })

  it('only counts the kind they asked about', async () => {
    schedule = [lecture('CVE575', '08:00'), lecture('ABE501', '12:00')]
    // Two lectures are not two exams.
    expect(await ask('when is the exam?')).toBeNull()
  })

  it('ignores a sentence with no bare event noun in it', async () => {
    schedule = [lecture('CVE575', '08:00'), lecture('ABE501', '12:00')]
    expect(await ask('what did the lecturer say?')).toBeNull()
    expect(await ask('send me the slides')).toBeNull()
  })
})
