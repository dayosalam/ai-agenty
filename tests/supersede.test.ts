import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Extraction, Message, User } from '../src/models/index.js'

let stored: Extraction[] = []
const superseded: Array<{ eventId: string; by: string }> = []
const sent: string[] = []

vi.mock('../src/repositories/index.js', () => ({
  extractionRepository: {
    findSimilar: vi.fn(async () => null),
    findChanged: vi.fn(async (candidate: Extraction) => {
      if (!candidate.date || (!candidate.time && !candidate.venue)) return null
      return (
        stored.find(
          (row) =>
            row.courseKey === candidate.courseKey &&
            row.eventType === candidate.eventType &&
            row.date === candidate.date &&
            row.eventId !== candidate.eventId &&
            row.supersededBy === null &&
            ((candidate.time && row.time && row.time !== candidate.time) ||
              (candidate.venue && row.venue && row.venue !== candidate.venue)),
        ) ?? null
      )
    }),
    supersede: vi.fn(async (eventId: string, by: string) => {
      superseded.push({ eventId, by })
    }),
    coursesSeenIn: vi.fn(async () => seenCourses),
    enrich: vi.fn(),
    addCorroboration: vi.fn(),
  },
  userRepository: {
    subscribedTo: vi.fn(async () => [student]),
    allRegistered: vi.fn(async () => [student, other]),
  },
  notificationRepository: { log: vi.fn() },
  groupRepository: { findByJid: vi.fn(async () => null) },
  messageRepository: { findById: vi.fn(async () => null) },
  pendingRepository: { open: vi.fn() },
}))

vi.mock('../src/services/delivery.service.js', () => ({
  deliveryService: {
    send: vi.fn(async (_s: User, body: string) => {
      sent.push(body)
      return true
    }),
  },
}))
vi.mock('../src/services/conversation.service.js', () => ({
  conversationService: { rememberEvent: vi.fn() },
}))
vi.mock('../src/services/notifier.service.js', () => ({ notifierService: { sendText: vi.fn() } }))
vi.mock('../src/services/operator.js', () => ({ operatorJid: vi.fn(async () => null) }))

const { announcementService } = await import('../src/services/announcement.service.js')

let seenCourses: string[] = []

const student = {
  phone: '234',
  jid: '234@s.whatsapp.net',
  courseKeys: ['CVE575'],
} as User

const other = { phone: '235', jid: '235@s.whatsapp.net', courseKeys: ['ABE501'] } as User

function row(over: Partial<Extraction>): Extraction {
  return {
    eventId: `e-${Math.random()}`,
    sourceMessageId: 'src',
    chatJid: '1@g.us',
    course: 'CVE 575',
    courseKey: 'CVE575',
    scope: 'course',
    eventType: 'test',
    originalDateText: 'Friday',
    date: '2026-09-18',
    time: '10:00',
    venue: 'LG7',
    confidence: 0.9,
    authority: 'student',
    corroboratedBy: [],
    supersededBy: null,
    extractedAt: new Date(),
    ...over,
  }
}

const source = {
  waMessageId: 'm',
  senderName: 'Dr Bello',
  type: 'text',
  timestamp: new Date(),
} as Message

beforeEach(() => {
  stored = []
  seenCourses = []
  superseded.length = 0
  sent.length = 0
})

/**
 * The gap this closes: findSimilar deliberately refuses to merge two different
 * venues, because two venues are not one event. Nothing then marked the old row
 * dead, so both survived into digests and reminders and the student was told a venue
 * that had moved two days earlier.
 */
describe('an announcement that changes an earlier one', () => {
  it('replaces the old venue rather than adding a second event', async () => {
    stored = [row({ eventId: 'old', venue: 'LG7', authority: 'rep' })]

    await announcementService.notify(
      [row({ eventId: 'new', venue: 'LG8', authority: 'rep' })],
      source,
    )

    expect(superseded).toEqual([{ eventId: 'old', by: 'new' }])
  })

  /** "LG8" alone reads as a fresh announcement; the old value is what makes it news. */
  it('says what it was, not just what it is now', async () => {
    stored = [row({ eventId: 'old', time: '10:00', venue: 'LG7' })]

    await announcementService.notify([row({ eventId: 'new', time: '14:00', venue: 'LG8' })], source)

    expect(sent[0]).toMatch(/changed/i)
    expect(sent[0]).toMatch(/Now:.*2pm, LG8/)
    expect(sent[0]).toMatch(/Was: 10am, LG7/)
  })

  it('lets a lecturer correct a classmate', async () => {
    stored = [row({ eventId: 'old', venue: 'LG7', authority: 'student' })]

    await announcementService.notify(
      [row({ eventId: 'new', venue: 'LG8', authority: 'lecturer' })],
      source,
    )
    expect(superseded).toHaveLength(1)
  })

  /**
   * A classmate does not get to overrule the lecturer. Both rows stand and the
   * student sees a disagreement, which is the honest outcome.
   */
  it('refuses to let a classmate overrule a lecturer', async () => {
    stored = [row({ eventId: 'old', venue: 'LG7', authority: 'lecturer' })]

    await announcementService.notify(
      [row({ eventId: 'new', venue: 'LG8', authority: 'student' })],
      source,
    )
    expect(superseded).toHaveLength(0)
    expect(sent[0]).not.toMatch(/changed/i)
  })

  it('leaves an unrelated event alone', async () => {
    stored = [row({ eventId: 'old', date: '2026-09-18', venue: 'LG7' })]

    await announcementService.notify(
      [row({ eventId: 'new', date: '2026-09-25', venue: 'LG8' })],
      source,
    )
    expect(superseded).toHaveLength(0)
  })

  /** A silence is not a correction — it is a shorter telling of the same thing. */
  it('does not treat a missing venue as a change', async () => {
    stored = [row({ eventId: 'old', venue: 'LG7' })]

    await announcementService.notify([row({ eventId: 'new', venue: null, time: '10:00' })], source)
    expect(superseded).toHaveLength(0)
  })
})

/**
 * A departmental group carries both kinds. "CVE 575 test moved" belongs to one course;
 * "no lectures on Friday" belongs to everybody and has no course to file it under —
 * which is indistinguishable from a course that could not be worked out unless the
 * extractor says which it meant.
 */
describe('a department-wide notice', () => {
  const notice = () =>
    row({ scope: 'department', course: null, courseKey: null, eventType: 'meeting', venue: null })

  it('is sent rather than held for the operator to triage', async () => {
    seenCourses = ['CVE575']
    await announcementService.notify([notice()], source)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/Department notice/i)
    expect(sent[0]).toMatch(/for everybody/i)
  })

  /** Otherwise a civil engineering notice reaches the biology cohort. */
  it('goes to the cohort that group serves, not to everyone Peermate knows', async () => {
    seenCourses = ['CVE575']
    await announcementService.notify([notice()], source)
    expect(sent).toHaveLength(1)
  })

  it('falls back to everyone before the group has carried anything', async () => {
    seenCourses = []
    await announcementService.notify([notice()], source)
    expect(sent).toHaveLength(2)
  })

  /** Two unrelated notices are not one event told twice. */
  it('is never deduped or superseded against a course announcement', async () => {
    stored = [row({ eventId: 'old', venue: 'LG7' })]
    seenCourses = ['CVE575']

    await announcementService.notify([notice()], source)
    expect(superseded).toHaveLength(0)
  })
})
