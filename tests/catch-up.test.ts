import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Extraction, Group, Resource, User } from '../src/models/index.js'

let approvedGroups: Group[] = []
let pendingGroups: Group[] = []
let archive: Extraction[] = []
let files: Resource[] = []

vi.mock('../src/repositories/index.js', () => ({
  extractionRepository: {
    forCourses: vi.fn(async (keys: string[], since: Date) =>
      archive.filter((item) => keys.includes(item.courseKey!) && item.extractedAt >= since),
    ),
    dueOn: vi.fn(async () => []),
  },
  groupRepository: {
    approved: vi.fn(async () => approvedGroups),
    pending: vi.fn(async () => pendingGroups),
  },
  resourceRepository: { forCourse: vi.fn(async () => files) },
  messageRepository: { findById: vi.fn(async () => null) },
  notificationRepository: { log: vi.fn() },
  userRepository: { upsert: vi.fn(), allRegistered: vi.fn(async () => []), dueForDigest: vi.fn() },
}))

vi.mock('../src/services/notifier.service.js', () => ({ notifierService: { sendText: vi.fn() } }))
vi.mock('../src/services/delivery.service.js', () => ({ deliveryService: { send: vi.fn() } }))
vi.mock('../src/services/tts.service.js', () => ({
  ttsService: { speak: vi.fn() },
  VOICE_MIME: '',
}))

const { digestService } = await import('../src/services/digest.service.js')

function group(courseKey: string, name = 'Peermate'): Group {
  return {
    chatJid: `${courseKey}@g.us`,
    name,
    defaultCourse: courseKey.replace(/(\d)/, ' $1'),
    defaultCourseKey: courseKey,
    status: 'approved',
    addedBy: null,
    addedByName: null,
    participantCount: null,
    proposedCourse: null,
    proposedBy: null,
    trustedSenders: [],
    joinedAt: new Date(),
    approvedAt: new Date(),
  }
}

const student = (courseKeys: string[]): User =>
  ({ phone: '234', jid: '234@s.whatsapp.net', displayName: 'Amina', courseKeys }) as User

beforeEach(() => {
  approvedGroups = []
  pendingGroups = []
  archive = []
  files = []
})

/**
 * The reply this exists for listed all eight of a student's courses — seven of which
 * Peermate is in no group for, so it could not have heard anything about them. True,
 * and useless: no way to tell an empty week from a broken setup.
 */
describe('asking what has happened when nothing has', () => {
  it('names only the courses it could actually have heard from', async () => {
    approvedGroups = [group('CVE575')]

    const answer = await digestService.catchUp(
      student(['CVE575', 'CVE567', 'ABE501']),
      7,
      'this week',
    )
    expect(answer).toMatch(/CVE 575/)
    expect(answer).not.toMatch(/Nothing (has been announced|at all) in [^\n]*CVE 567/)
  })

  it('names the courses no group covers, as the reason it has nothing', async () => {
    approvedGroups = [group('CVE575')]

    const answer = await digestService.catchUp(student(['CVE575', 'CVE567']), 7, 'this week')
    expect(answer).toMatch(/in no group for CVE 567/i)
  })

  it('says nothing could have been heard at all when no group is connected', async () => {
    pendingGroups = [{ ...group('CVE575'), status: 'pending' }]

    const answer = await digestService.catchUp(student(['CVE575']), 7, 'this week')
    expect(answer).toMatch(/not reading any group/i)
    expect(answer).toMatch(/waiting to be approved/i)
  })

  /** "Nothing this week" reads very differently when ten things sit just behind it. */
  it('offers the older items rather than implying there are none', async () => {
    approvedGroups = [group('CVE575')]
    archive = [
      { courseKey: 'CVE575', extractedAt: new Date('2020-01-01'), eventType: 'test' } as Extraction,
    ]

    const answer = await digestService.catchUp(student(['CVE575']), 7, 'this week')
    expect(answer).toMatch(/\*1\* older thing/)
    expect(answer).toMatch(/look further back/i)
  })

  it('distinguishes an empty archive from an empty week', async () => {
    approvedGroups = [group('CVE575')]

    const answer = await digestService.catchUp(student(['CVE575']), 7, 'this week')
    expect(answer).toMatch(/no announcements, no files/i)
    expect(answer).not.toMatch(/older thing/)
  })

  it('counts the files it holds even when nothing was announced', async () => {
    approvedGroups = [group('CVE575')]
    files = [{ fileName: 'week4.pdf' } as Resource, { fileName: 'notes.pdf' } as Resource]

    const answer = await digestService.catchUp(student(['CVE575']), 7, 'this week')
    // Never "no files" in the same breath as a count of them.
    expect(answer).not.toMatch(/no files/)
    expect(answer).toMatch(/\*2\* files people shared/)
    expect(answer).toMatch(/CVE 575 resources/)
  })

  it('still says the obvious thing when they watch no courses', async () => {
    const answer = await digestService.catchUp(student([]), 7, 'this week')
    expect(answer).toMatch(/not watching any courses/i)
  })
})
