import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Extraction, ScheduleEntry, User } from '../src/models/index.js'

let schedule: ScheduleEntry[] = []
let announced: Extraction[] = []
const amended: Array<{ courseKey: string; kind: string | null; patch: unknown }> = []
const removed: Array<{ courseKey: string; kind: string | null }> = []

vi.mock('../src/repositories/index.js', () => ({
  scheduleRepository: {
    forStudent: vi.fn(async () => schedule),
    insertMany: vi.fn(),
    replaceKinds: vi.fn(async () => 0),
    amend: vi.fn(async (_p: string, courseKey: string, kind: string | null, patch: unknown) => {
      amended.push({ courseKey, kind, patch })
      return 1
    }),
    remove: vi.fn(async (_p: string, courseKey: string, kind: string | null) => {
      removed.push({ courseKey, kind })
      return 1
    }),
  },
  extractionRepository: {
    dueOn: vi.fn(async (_keys: string[], date: string) =>
      announced.filter((item) => item.date === date),
    ),
    forCourses: vi.fn(async () => announced),
  },
}))

const { scheduleService } = await import('../src/services/schedule.service.js')

const student = { phone: '234', courseKeys: ['CVE575', 'ABE501'] } as User

/** A Wednesday, 07:00 Lagos. */
const WED = new Date('2026-09-16T07:00:00+01:00')

function entry(over: Partial<ScheduleEntry>): ScheduleEntry {
  return {
    phone: '234',
    course: 'CVE 575',
    courseKey: 'CVE575',
    kind: 'lecture',
    date: null,
    weekday: null,
    time: null,
    venue: null,
    sourceMessageId: 'img-1',
    createdAt: new Date(),
    ...over,
  }
}

beforeEach(() => {
  schedule = []
  announced = []
  amended.length = 0
  removed.length = 0
})

describe('asking about your own timetable', () => {
  it('lists what is on today', async () => {
    schedule = [
      entry({ weekday: 3, time: '08:00', venue: 'LG7' }),
      entry({ weekday: 4, time: '10:00' }),
    ]

    const answer = await scheduleService.answer(student, 'today', null, WED)
    expect(answer).toMatch(/Today/)
    expect(answer).toMatch(/8am — CVE 575 lecture, LG7/)
    // Thursday's class is not today's business.
    expect(answer).not.toMatch(/10am/)
  })

  /**
   * One question, two sources: the weekly lecture from the photograph they sent, and
   * the test a lecturer announced this morning. Either alone answers half of it.
   */
  it('merges what a group announced with what they uploaded', async () => {
    schedule = [entry({ weekday: 3, time: '08:00' })]
    announced = [
      {
        courseKey: 'CVE575',
        eventType: 'test',
        date: '2026-09-16',
        time: '14:00',
        venue: 'LT2',
      } as Extraction,
    ]

    const answer = await scheduleService.answer(student, 'today', null, WED)
    expect(answer).toMatch(/CVE 575 lecture/)
    expect(answer).toMatch(/CVE 575 test.*LT2.*announced/)
  })

  it('answers about tomorrow without today in the way', async () => {
    schedule = [entry({ weekday: 3, time: '08:00' }), entry({ weekday: 4, time: '10:00' })]

    const answer = await scheduleService.answer(student, 'tomorrow', null, WED)
    expect(answer).toMatch(/Thursday/)
    expect(answer).toMatch(/10am/)
    expect(answer).not.toMatch(/8am/)
  })

  /**
   * A weekly class has a weekday and no date. Counting only dated rows answered
   * "nothing on your timetable" to somebody with a lecture the next morning.
   */
  it('counts a weekly class as the next thing coming up', async () => {
    schedule = [entry({ kind: 'lecture', weekday: 4, time: '08:00', venue: 'LG7' })]

    const answer = await scheduleService.answer(student, 'next', null, WED)
    expect(answer).toMatch(/Next lecture: CVE 575/)
    expect(answer).toMatch(/Tomorrow at 8am, LG7/)
  })

  it('puts an announced test ahead of a class later in the week', async () => {
    schedule = [entry({ kind: 'lecture', weekday: 5, time: '08:00' })]
    announced = [
      { courseKey: 'ABE501', eventType: 'test', date: '2026-09-17', time: '10:00' } as Extraction,
    ]

    const answer = await scheduleService.answer(student, 'next', null, WED)
    expect(answer).toMatch(/Next test: ABE 501/)
    expect(answer).toMatch(/announced in your group/)
    expect(answer).toMatch(/After that[\s\S]*CVE 575 lecture/)
  })

  /** This morning's lecture is over; a weekly one comes round again next week. */
  it('rolls a weekly class past today once it has been', async () => {
    schedule = [entry({ kind: 'lecture', weekday: 3, time: '06:00' })]

    const answer = await scheduleService.answer(student, 'next', null, WED)
    expect(answer).toMatch(/Wednesday 09-23/)
    expect(answer).not.toMatch(/Today/)
  })

  /**
   * Two different states, and they must not read the same. "Nothing coming up" about a
   * timetable Peermate has never seen tells the student their week is clear when in
   * fact nothing was ever uploaded.
   */
  it('says nothing is coming up when it holds a timetable with nothing ahead', async () => {
    schedule = [entry({ kind: 'exam', date: '2020-01-01', time: '08:00' })]
    expect(await scheduleService.answer(student, 'next', null, WED)).toMatch(/Nothing coming up/)
  })

  it('admits it has never seen a timetable rather than calling the week clear', async () => {
    expect(await scheduleService.answer(student, 'next', null, WED)).toBeNull()
  })

  it('names the next dated thing, and what follows it', async () => {
    schedule = [
      entry({ kind: 'exam', date: '2026-09-25', time: '08:30', venue: 'NELT 1' }),
      entry({ kind: 'exam', courseKey: 'ABE501', date: '2026-09-20', time: '10:00' }),
    ]

    const answer = await scheduleService.answer(student, 'next', null, WED)
    expect(answer).toMatch(/Next exam: ABE 501/)
    expect(answer).toMatch(/After that/)
    expect(answer).toMatch(/CVE 575 exam — Friday 09-25/)
  })

  it('narrows to one course when they named one', async () => {
    schedule = [
      entry({ weekday: 3, time: '08:00' }),
      entry({ weekday: 3, time: '12:00', courseKey: 'ABE501', course: 'ABE 501' }),
    ]

    const answer = await scheduleService.answer(student, 'today', 'ABE501', WED)
    expect(answer).toMatch(/ABE 501/)
    expect(answer).not.toMatch(/CVE 575/)
  })

  /**
   * Asked on a Saturday, "how many classes do I have on Tuesday?" used to be routed to
   * "tomorrow" and answered about Sunday — a confident answer to a question nobody
   * asked, and no way for the student to tell.
   */
  it('answers about a weekday they named, not about tomorrow', async () => {
    schedule = [
      entry({ weekday: 2, time: '08:00' }),
      entry({ weekday: 2, time: '14:00', courseKey: 'ABE501', course: 'ABE 501' }),
      entry({ weekday: 0, time: '10:00' }),
    ]
    const SAT = new Date('2026-09-12T09:00:00+01:00')

    const answer = await scheduleService.answer(student, 'tuesday', null, SAT)
    expect(answer).toMatch(/Tuesday 09-15/)
    expect(answer).toMatch(/8am/)
    expect(answer).toMatch(/2pm/)
    expect(answer).not.toMatch(/10am/)
  })

  /** Asked on a Wednesday, "on Wednesday" means today, not a week from now. */
  it('reads a named weekday as today when today is that day', async () => {
    schedule = [entry({ weekday: 3, time: '08:00' })]
    expect(await scheduleService.answer(student, 'wednesday', null, WED)).toMatch(/Today/)
  })

  it('names the day when nothing is on it', async () => {
    schedule = [entry({ weekday: 3, time: '08:00' })]
    const answer = await scheduleService.answer(student, 'friday', null, WED)
    expect(answer).toMatch(/Nothing on your timetable on Friday 09-18/)
  })

  it('says nothing is on rather than inventing something', async () => {
    schedule = [entry({ weekday: 5, time: '08:00' })]
    expect(await scheduleService.answer(student, 'today', null, WED)).toMatch(/Nothing on your/i)
  })

  /**
   * The distinction that matters: an empty week and a timetable Peermate has never
   * seen look identical to the student unless it says which one this is.
   */
  it('returns null when it has never been sent a timetable', async () => {
    expect(await scheduleService.answer(student, 'today', null, WED)).toBeNull()
    expect(await scheduleService.answer(student, 'week', null, WED)).toBeNull()
  })
})

/**
 * Nobody re-photographs a timetable because one room changed. Refusing the spoken
 * correction means the stored copy drifts and the reminders it drives go quietly
 * wrong — worse than having no timetable at all.
 */
describe('correcting a timetable in words', () => {
  const correction = (over: Record<string, unknown> = {}) =>
    ({
      kind: 'any',
      time: null,
      venue: null,
      weekday: null,
      date: null,
      remove: false,
      ...over,
    }) as never

  it('moves a class to a new time', async () => {
    schedule = [entry({ kind: 'lecture', weekday: 3, time: '08:00' })]

    const reply = await scheduleService.amend(student, 'CVE575', correction({ time: '10:00' }), WED)
    expect(reply).toMatch(/Updated/)
    expect(reply).toMatch(/10am/)
    expect(amended).toEqual([{ courseKey: 'CVE575', kind: null, patch: { time: '10:00' } }])
  })

  it('changes only the kind they named', async () => {
    schedule = [entry({ kind: 'lecture', weekday: 3 }), entry({ kind: 'tutorial', weekday: 4 })]

    await scheduleService.amend(
      student,
      'CVE575',
      correction({ kind: 'tutorial', venue: 'LG8' }),
      WED,
    )
    expect(amended[0]!.kind).toBe('tutorial')
  })

  it('refuses a date it cannot verify, rather than storing a guess', async () => {
    schedule = [entry({ kind: 'exam', date: '2026-09-20' })]

    const reply = await scheduleService.amend(
      student,
      'CVE575',
      correction({ date: 'sometime' }),
      WED,
    )
    expect(reply).toMatch(/didn't catch what changed/i)
    expect(amended).toHaveLength(0)
  })

  it('says there is nothing to change rather than inventing a row', async () => {
    const reply = await scheduleService.amend(student, 'CVE575', correction({ time: '10:00' }), WED)
    expect(reply).toMatch(/nothing to change/i)
    expect(amended).toHaveLength(0)
  })

  it('removes an entry when that is what they asked for', async () => {
    schedule = [entry({ kind: 'tutorial', weekday: 3 })]

    const reply = await scheduleService.amend(
      student,
      'CVE575',
      correction({ kind: 'tutorial', remove: true }),
      WED,
    )
    expect(reply).toMatch(/Removed/)
    expect(removed).toEqual([{ courseKey: 'CVE575', kind: 'tutorial' }])
  })
})
