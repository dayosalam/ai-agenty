import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Group, User } from '../src/models/index.js'

let pending: Group[] = []
let approved: Group[] = []

vi.mock('../src/repositories/index.js', () => ({
  groupRepository: {
    pending: vi.fn(async () => pending),
    approved: vi.fn(async () => approved),
  },
}))

const { guidanceService } = await import('../src/services/guidance.service.js')

function group(over: Partial<Group>): Group {
  return {
    chatJid: '120363430457309406@g.us',
    name: 'Peermate',
    defaultCourse: null,
    defaultCourseKey: null,
    status: 'pending',
    addedBy: null,
    addedByName: null,
    participantCount: 2,
    proposedCourse: null,
    proposedBy: null,
    trustedSenders: [],
    joinedAt: new Date(),
    approvedAt: null,
    ...over,
  }
}

const student: User = {
  phone: '2348100000000',
  jid: '2348100000000@s.whatsapp.net',
  name: null,
  displayName: 'Amina',
  courseKeys: ['CVE575', 'STA202'],
  onboardingState: 'registered',
  registeredAt: new Date(),
  lastDigestAt: null,
  digestFormat: 'text',
  digestHour: 6,
  quietFrom: 22,
  quietTo: 6,
  pausedUntil: null,
  paused: false,
  digestPaused: false,
  alertLevel: 'all',
  mutedCourseKeys: [],
}

beforeEach(() => {
  pending = []
  approved = []
})

/**
 * The gate matters as much as the answers. "How do I approve it?" is about Peermate;
 * "how do I get to LG7?" is about the world, and answering it with instructions would
 * be worse than searching the archive for it.
 */
describe('telling a question about Peermate from a question about a course', () => {
  it('recognises a how-to about Peermate', () => {
    for (const text of [
      'how do I approve it?',
      'How do I approve the group',
      'how can I add a course',
      'how do I stop the morning messages',
      'what does approve mean?',
      'how i go take remove a course',
      'how does this work',
    ]) {
      expect(guidanceService.looksLikeAboutPeermate(text), text).toBe(true)
    }
  })

  it('leaves a question about the world to retrieval', () => {
    for (const text of [
      'how do I get to LG7?',
      'when is the CVE 575 test?',
      'how many questions are in the test',
      'who said that?',
      'how did he say it would be graded',
    ]) {
      expect(guidanceService.looksLikeAboutPeermate(text), text).toBe(false)
    }
  })
})

/**
 * The regression: an operator asking this got "I haven't heard anything about that
 * yet", because the question went to the archive instead of to Peermate's own
 * knowledge of its commands.
 */
describe('"how do I approve it?"', () => {
  it('names the group waiting and the course somebody proposed for it', async () => {
    pending = [group({ proposedCourse: 'CVE 575', proposedBy: 'Adedamola' })]

    const answer = await guidanceService.answer(student, 'how do I approve it?', true)
    expect(answer).toMatch(/approve CVE 575/)
    expect(answer).toMatch(/Peermate/)
    expect(answer).toMatch(/Adedamola/)
    // The mistake this stops: replying inside the group, which is never read.
    expect(answer).toMatch(/in this chat/i)
  })

  it('falls back to a real example when no course was proposed', async () => {
    pending = [group({ name: 'Dept Notices' })]

    const answer = await guidanceService.answer(student, 'how do I approve it?', true)
    expect(answer).toMatch(/Dept Notices/)
    expect(answer).toMatch(/approve <course code>/)
  })

  it('says there is nothing waiting rather than explaining a command they cannot use', async () => {
    approved = [group({ status: 'approved', defaultCourse: 'CVE 575' })]

    const answer = await guidanceService.answer(student, 'how do I approve it?', true)
    expect(answer).toMatch(/Nothing is waiting/i)
  })

  it('does not hand a student a command that would do nothing for them', async () => {
    pending = [group({ proposedCourse: 'CVE 575' })]

    const answer = await guidanceService.answer(student, 'how do I approve it?', false)
    expect(answer).not.toMatch(/send \*approve/i)
    expect(answer).toMatch(/operator/i)
    expect(answer).toMatch(/tell me which course/i)
  })
})

describe('the other things people ask how to do', () => {
  it('answers about courses with what they are already watching', async () => {
    const answer = await guidanceService.answer(student, 'how do I add a course?', false)
    expect(answer).toMatch(/add MTH 101/)
    expect(answer).toMatch(/CVE 575/)
  })

  it('answers about files using a course they actually take', async () => {
    const answer = await guidanceService.answer(student, 'how do I get the slides?', false)
    expect(answer).toMatch(/CVE 575 resources/)
  })

  it('answers about the digest with their own delivery time', async () => {
    const answer = await guidanceService.answer(student, 'how do I change the digest?', false)
    expect(answer).toMatch(/6am/)
  })

  it('answers about going quiet without mentioning anything being lost', async () => {
    const answer = await guidanceService.answer(student, 'how do I stop the alerts?', false)
    expect(answer).toMatch(/pause until Monday/)
    expect(answer).toMatch(/Nothing is lost/i)
  })

  it('gives the operator their own commands in the general answer', async () => {
    expect(await guidanceService.answer(student, 'how does this work?', true)).toMatch(/admin/)
    expect(await guidanceService.answer(student, 'how does this work?', false)).not.toMatch(
      /\*admin\*/,
    )
  })
})

/**
 * The regression: "What group have you been approved for?" was answered with "that's
 * outside what I do" — when Peermate is the only thing in the world that knows.
 */
describe('asking what it is actually set up to read', () => {
  it('recognises a question about its own state', () => {
    for (const text of [
      'What group have you been approved for?',
      'which groups are you reading',
      'what groups have you been approved for',
      'are you reading the group?',
      'how many groups are you connected to',
    ]) {
      expect(guidanceService.looksLikeAboutPeermate(text), text).toBe(true)
    }
  })

  it('leaves a question about a classmate to retrieval', () => {
    for (const text of ['what group did he post that in?', 'which group had the test']) {
      expect(guidanceService.looksLikeAboutPeermate(text), text).toBe(false)
    }
  })

  it('names the groups it reads and the course each is filed under', async () => {
    approved = [
      group({
        status: 'approved',
        name: 'Peermate',
        defaultCourse: 'CVE 575',
        defaultCourseKey: 'CVE575',
      }),
    ]

    const answer = await guidanceService.answer(
      student,
      'what group have you been approved for?',
      true,
    )
    expect(answer).toMatch(/Peermate/)
    expect(answer).toMatch(/CVE 575/)
  })

  /** A course with no group behind it is a course they will never hear about. */
  it('warns about their courses that no group covers', async () => {
    approved = [group({ status: 'approved', defaultCourse: 'CVE 575', defaultCourseKey: 'CVE575' })]

    const answer = await guidanceService.answer(student, 'which groups are you reading?', false)
    expect(answer).toMatch(/Nothing connected yet for STA 202/)
  })

  it('names what is still waiting, and says whose job approving it is', async () => {
    pending = [group({ proposedCourse: 'CVE 575' })]

    expect(await guidanceService.answer(student, 'are you reading the group?', true)).toMatch(
      /approve <course>/,
    )
    expect(await guidanceService.answer(student, 'are you reading the group?', false)).toMatch(
      /operator has to approve/i,
    )
  })

  it('says plainly when it is reading nothing at all', async () => {
    const answer = await guidanceService.answer(student, 'which groups are you reading?', true)
    expect(answer).toMatch(/not reading any group yet/i)
  })
})
