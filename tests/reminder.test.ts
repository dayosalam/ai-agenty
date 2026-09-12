import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Extraction, ScheduleEntry, User } from '../src/models/index.js'

let schedule: ScheduleEntry[] = []
let archive: Extraction[] = []
let alreadySent: string[] = []
const sent: string[] = []

vi.mock('../src/repositories/index.js', () => ({
  scheduleRepository: { forStudent: vi.fn(async () => schedule) },
  extractionRepository: { forCourses: vi.fn(async () => archive) },
  notificationRepository: {
    alreadySent: vi.fn(async (_phone: string, id: string) => alreadySent.includes(id)),
    log: vi.fn(async (n: { extractionId: string | null }) => {
      if (n.extractionId) alreadySent.push(n.extractionId)
    }),
  },
  userRepository: { allRegistered: vi.fn(async () => []) },
}))

vi.mock('../src/services/conversation.service.js', () => ({
  conversationService: { rememberCourse: vi.fn() },
}))

const direct: string[] = []
vi.mock('../src/services/notifier.service.js', () => ({
  notifierService: {
    sendText: vi.fn(async (_jid: string, body: string) => {
      direct.push(body)
    }),
  },
}))

vi.mock('../src/services/delivery.service.js', () => ({
  deliveryService: {
    send: vi.fn(async (_student: User, body: string) => {
      sent.push(body)
      return true
    }),
  },
}))

const { reminderService } = await import('../src/services/reminder.service.js')

const student = { phone: '234', jid: '234@s.whatsapp.net', courseKeys: ['CVE575'] } as User

/** A Wednesday, 08:00 Lagos. */
const WED_0800 = new Date('2026-09-16T08:00:00+01:00')

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
  archive = []
  alreadySent = []
  sent.length = 0
  direct.length = 0
})

/**
 * The message that arrives before the thing, not after it. An announcement tells a
 * student a lecture exists; only a reminder helps at 08:15 when it starts at 09:00.
 */
describe('when a reminder fires', () => {
  it('warns 45 minutes before a weekly lecture', async () => {
    schedule = [entry({ weekday: 3, time: '08:45', venue: 'LG7' })]

    await reminderService.runFor(student, WED_0800)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/CVE 575 lecture/)
    expect(sent[0]).toMatch(/LG7/)
  })

  it('stays silent when nothing is close', async () => {
    schedule = [entry({ weekday: 3, time: '15:00' })]
    await reminderService.runFor(student, WED_0800)
    expect(sent).toHaveLength(0)
  })

  /** An exam you prepare for the night before; a lecture you walk to. */
  it('gives an exam a day of warning and a lecture an hour', async () => {
    schedule = [
      entry({ kind: 'exam', date: '2026-09-17', time: '08:00' }),
      entry({ kind: 'lecture', weekday: 3, time: '08:45' }),
    ]

    await reminderService.runFor(student, WED_0800)
    expect(sent).toHaveLength(2)
    expect(sent.join('\n')).toMatch(/exam.*tomorrow/s)
  })

  it('never sends the same reminder twice', async () => {
    schedule = [entry({ weekday: 3, time: '08:45' })]

    await reminderService.runFor(student, WED_0800)
    await reminderService.runFor(student, WED_0800)
    expect(sent).toHaveLength(1)
  })

  /** Two warnings about one exam are two reminders, not a duplicate. */
  it('lets the day-before and the two-hour warning both through', async () => {
    schedule = [entry({ kind: 'exam', date: '2026-09-17', time: '08:00' })]

    await reminderService.runFor(student, WED_0800)
    await reminderService.runFor(student, new Date('2026-09-17T06:00:00+01:00'))
    expect(sent).toHaveLength(2)
  })

  it('reminds about what a group announced, not just the uploaded timetable', async () => {
    archive = [
      {
        eventId: 'evt-1',
        courseKey: 'CVE575',
        course: 'CVE 575',
        eventType: 'test',
        date: '2026-09-17',
        time: '09:00',
        venue: 'LT2',
      } as Extraction,
    ]

    // 24 hours before a 09:00 test is 09:00 the day before.
    await reminderService.runFor(student, new Date('2026-09-16T09:00:00+01:00'))
    expect(sent[0]).toMatch(/CVE 575 test/)
    expect(sent[0]).toMatch(/LT2/)
  })

  /** A tick that runs a few minutes late must not drop the reminder for good. */
  it('still fires when the scheduler runs slightly late', async () => {
    schedule = [entry({ weekday: 3, time: '08:45' })]
    await reminderService.runFor(student, new Date('2026-09-16T08:04:00+01:00'))
    expect(sent).toHaveLength(1)
  })

  it('ignores an entry with no time, which pins it to no moment', async () => {
    schedule = [entry({ weekday: 3, time: null })]
    await reminderService.runFor(student, WED_0800)
    expect(sent).toHaveLength(0)
  })
})

/**
 * Reminders are the one feature that cannot be shown on camera without waiting for
 * the clock. This shortcuts the timing, never the content.
 */
describe('the demo preview', () => {
  it('says nothing back, then sends the real thing', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(WED_0800)
      schedule = [entry({ weekday: 3, time: '15:00', venue: 'LG7' })]

      // An acknowledgement would arrive first and announce the delay — on camera the
      // reminder has to look like it turned up on its own.
      expect(await reminderService.previewIn(student, 10_000)).toBeNull()
      expect(direct).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(direct[0]).toMatch(/CVE 575 lecture/)
      expect(direct[0]).toMatch(/LG7/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('picks the closest thing, not the first stored', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(WED_0800)
      schedule = [
        entry({ kind: 'exam', date: '2026-09-25', time: '08:00' }),
        entry({ weekday: 3, time: '09:00', courseKey: 'ABE501', course: 'ABE 501' }),
      ]

      await reminderService.previewIn(student, 10_000)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(direct[0]).toMatch(/ABE 501/)
    } finally {
      vi.useRealTimers()
    }
  })

  /** The one case worth breaking the silence for: nothing was scheduled to arrive. */
  it('says so plainly when there is nothing coming up', async () => {
    expect(await reminderService.previewIn(student, 10_000)).toMatch(/Nothing upcoming/i)
  })
})
