import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Extraction, Group, Message, User } from '../src/models/index.js'
import type { Routed } from '../src/services/router.service.js'

const PHONE = '2348100000000'
const JID = `${PHONE}@s.whatsapp.net`

let user: User
let conversation: Conversation | null = null
let pendingGroups: Group[] = []
const outbox: string[] = []
const sentFiles: string[] = []
const proposed: Array<{ chatJid: string; course: string }> = []

const extraction: Extraction = {
  eventId: 'evt-1',
  sourceMessageId: 'src-1',
  chatJid: '1@g.us',
  course: 'CSC 301',
  courseKey: 'CSC301',
  eventType: 'test',
  originalDateText: 'Friday',
  date: '2026-09-18',
  time: '10:00',
  venue: 'LG7',
  confidence: 0.9,
  authority: 'lecturer',
  corroboratedBy: [],
  extractedAt: new Date(),
}

const sourceMessage = {
  waMessageId: 'src-1',
  chatJid: '1@g.us',
  senderName: 'Dr Bello',
  type: 'audio',
  transcript: 'The CSC 301 test holds Friday 10am in LG7.',
  text: null,
  caption: null,
  mediaKey: 'audio/src-1',
  mimeType: 'audio/ogg',
  timestamp: new Date('2026-09-12T08:43:00+01:00'),
} as unknown as Message

vi.mock('../src/repositories/index.js', () => ({
  userRepository: {
    findByPhone: vi.fn(async () => user),
    upsert: vi.fn(async (next: User) => {
      user = next
    }),
  },
  groupRepository: {
    approved: vi.fn(async () => []),
    pending: vi.fn(async () => pendingGroups),
    findByJid: vi.fn(async (jid: string) => pendingGroups.find((g) => g.chatJid === jid) ?? null),
  },
  messageRepository: { findById: vi.fn(async () => sourceMessage) },
  extractionRepository: { findByEventId: vi.fn(async () => extraction) },
  conversationRepository: {
    find: vi.fn(async () => conversation),
    save: vi.fn(async (next: Conversation) => {
      conversation = next
    }),
    clear: vi.fn(async () => {
      conversation = null
    }),
  },
  resourceRepository: {
    forCourse: vi.fn(async (key: string) =>
      key === 'CSC301'
        ? [
            {
              fileName: 'CSC301_week4.pdf',
              mediaKey: 'doc/1',
              mimeType: 'application/pdf',
              courseKey: 'CSC301',
              docType: 'slides',
              postedBy: 'Dr Bello',
              postedAt: new Date(),
            },
          ]
        : [],
    ),
  },
}))

vi.mock('../src/services/notifier.service.js', () => ({
  notifierService: {
    sendText: vi.fn(async (_jid: string, text: string) => {
      outbox.push(text)
    }),
    sendFile: vi.fn(async (_jid: string, _key: string, fileName: string) => {
      sentFiles.push(fileName)
    }),
    sendVoiceNote: vi.fn(async () => {
      sentFiles.push('voice-note')
    }),
    sendImage: vi.fn(async () => {
      sentFiles.push('image')
    }),
    withTyping: vi.fn(async (_jid: string, work: () => Promise<unknown>) => work()),
  },
}))

vi.mock('../src/services/group.service.js', () => ({
  groupService: {
    propose: vi.fn(async (chatJid: string, course: string) => {
      proposed.push({ chatJid, course })
    }),
  },
}))

vi.mock('../src/db/minio.js', () => ({ getMedia: vi.fn(async () => Buffer.from('bytes')) }))
vi.mock('../src/services/openai.client.js', () => ({ getOpenAI: vi.fn() }))

const answer = vi.fn(async () => 'The CSC 301 test is Friday 10am in LG7.')
vi.mock('../src/services/qa.service.js', () => ({ qaService: { answer } }))

let route: Routed
vi.mock('../src/services/router.service.js', () => ({
  routerService: { route: async () => route },
}))

const { dmService } = await import('../src/services/dm.service.js')
const { conversationService } = await import('../src/services/conversation.service.js')

function routed(over: Partial<Routed>): Routed {
  return {
    intent: 'ask_question',
    courseCode: null,
    courseFromContext: false,
    sinceDays: null,
    periodLabel: null,
    filePositions: [],
    sendAll: false,
    docType: 'any',
    newName: null,
    isFollowUp: false,
    secondRequest: null,
    confidence: 0.9,
    ...over,
  }
}

function dm(text: string): Message {
  return {
    waMessageId: `m-${Math.random()}`,
    chatJid: JID,
    senderJid: JID,
    senderPhone: PHONE,
    senderName: 'Amina',
    fromGroup: false,
    timestamp: new Date(),
    type: 'text',
    text,
    caption: null,
    transcript: null,
    mediaKey: null,
    mimeType: null,
    fileName: null,
    quotedMessageId: null,
    processingStatus: 'done',
    processingError: null,
    processingAttempts: 0,
    ingestedAt: new Date(),
  } as Message
}

beforeEach(() => {
  outbox.length = 0
  sentFiles.length = 0
  proposed.length = 0
  pendingGroups = []
  conversation = null
  answer.mockClear()
  user = {
    phone: PHONE,
    jid: JID,
    name: 'Amina',
    displayName: 'Amina',
    courseKeys: ['CSC301', 'STA202'],
    onboardingState: 'registered',
    registeredAt: new Date(),
    lastDigestAt: null,
    digestFormat: 'text',
    digestHour: 7,
    quietFrom: null,
    quietTo: null,
    pausedUntil: null,
    paused: false,
    digestPaused: false,
    alertLevel: 'all',
    mutedCourseKeys: [],
  }
})

/**
 * The exchange the product is actually for: an alert arrives, and the student's next
 * three messages are all about it without ever naming it again.
 */
describe('following up on an alert', () => {
  it('answers "where is it?" against the event they were just sent', async () => {
    await conversationService.rememberEvent(PHONE, extraction)

    route = routed({ isFollowUp: true })
    await dmService.handle(dm('where is it?'))

    const [, , focus] = answer.mock.calls[0] as unknown as [
      string,
      string[],
      { extraction: Extraction },
    ]
    expect(focus.extraction.eventId).toBe('evt-1')
    expect(focus.extraction.venue).toBe('LG7')
  })

  it('scopes a follow-up to the course of that event, not every course', async () => {
    await conversationService.rememberEvent(PHONE, extraction)

    route = routed({ isFollowUp: true })
    await dmService.handle(dm('what time again?'))

    const [, scope] = answer.mock.calls[0] as unknown as [string, string[]]
    expect(scope).toEqual(['CSC301'])
  })

  it('sends the original voice note it was extracted from', async () => {
    await conversationService.rememberEvent(PHONE, extraction)

    route = routed({ intent: 'send_original', isFollowUp: true })
    await dmService.handle(dm('send me the original voice note'))

    expect(sentFiles).toContain('voice-note')
    expect(outbox.at(-1)).toMatch(/Dr Bello/)
  })

  it('says so plainly when there is nothing to follow up on', async () => {
    route = routed({ intent: 'send_original' })
    await dmService.handle(dm('send the original'))
    expect(outbox.at(-1)).toMatch(/not sure which one/i)
    expect(sentFiles).toHaveLength(0)
  })
})

/**
 * Repeating must not re-run retrieval: a second search can return a different answer,
 * which is the one thing "say that again" must never do.
 */
describe('repeat that', () => {
  it('returns the previous answer verbatim and asks nothing of the model', async () => {
    route = routed({})
    await dmService.handle(dm('when is the CSC 301 test?'))
    const first = outbox.at(-1)

    answer.mockClear()
    await dmService.handle(dm('repeat that'))

    expect(outbox.at(-1)).toBe(first)
    expect(answer).not.toHaveBeenCalled()
  })

  it('admits it when there is nothing to repeat', async () => {
    await dmService.handle(dm('say that again'))
    expect(outbox.at(-1)).toMatch(/haven't told you anything yet/i)
  })
})

describe('the resource menu', () => {
  it('takes a bare course code as the answer it just asked for', async () => {
    route = routed({ intent: 'request_resources' })
    await dmService.handle(dm('send me the resources'))
    expect(outbox.at(-1)).toMatch(/Which course/i)
    expect(conversation!.pendingAction).toBe('awaiting_resource_course')

    // No routing at all on the reply — the menu asked, so the answer is literal.
    route = routed({ intent: 'smalltalk', confidence: 0.1 })
    await dmService.handle(dm('CSC 301'))

    expect(sentFiles).toContain('CSC301_week4.pdf')
    expect(conversation!.pendingAction).toBeNull()
  })

  it('lets them change the subject instead of answering the menu', async () => {
    route = routed({ intent: 'request_resources' })
    await dmService.handle(dm('send me the resources'))

    route = routed({})
    await dmService.handle(dm('actually, when is the test?'))
    expect(answer).toHaveBeenCalled()
    expect(sentFiles).toHaveLength(0)
  })
})

describe('messages that are not questions', () => {
  it('says nothing to a thumbs-up', async () => {
    await dmService.handle(dm('👍'))
    expect(outbox).toHaveLength(0)
  })

  it('offers help to a puzzled face', async () => {
    await dmService.handle(dm('🤔'))
    expect(outbox.at(-1)).toMatch(/send \*help\*/i)
  })

  it('refuses an operator command from a student', async () => {
    await dmService.handle(dm('approve CSC 301'))
    expect(outbox.at(-1)).toMatch(/only whoever runs Peermate/i)
  })
})

/**
 * One intent can be acted on, so the reply has to name the half it did not do.
 * Silence about the second request reads as not having understood it.
 */
describe('two requests in one message', () => {
  it('answers the first and says what it did not do', async () => {
    route = routed({ secondRequest: 'send the slides' })
    await dmService.handle(dm('when is the test and send the slides?'))
    expect(outbox.at(-1)).toMatch(/also asked me to send the slides/i)
  })
})

function pendingGroup(over: Partial<Group> = {}): Group {
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

/**
 * What gets agreed here decides where every announcement from that group is filed for
 * the rest of the semester, and the student cannot see what their typed — or
 * photographed — course code became. Reading it back is cheaper than finding out in
 * week six that the alerts went somewhere else.
 */
describe('saying which course a group is for', () => {
  it('reads the pairing back instead of acting on it', async () => {
    pendingGroups = [pendingGroup()]
    route = routed({ intent: 'group_link' })

    await dmService.handle(dm('the group is for Cve 575'))

    expect(outbox.at(-1)).toMatch(/Peermate.*is the group for \*CVE 575\*/s)
    expect(proposed).toHaveLength(0)
    expect(conversation!.pendingAction).toBe('confirm_group_course')
  })

  it('relays it only once they agree', async () => {
    pendingGroups = [pendingGroup()]
    route = routed({ intent: 'group_link' })
    await dmService.handle(dm('the group is for Cve 575'))

    await dmService.handle(dm('yes'))

    expect(proposed).toEqual([{ chatJid: '120363430457309406@g.us', course: 'CVE 575' }])
    expect(outbox.at(-1)).toMatch(/not reading it yet/i)
    expect(conversation!.pendingAction).toBeNull()
  })

  it('takes a different code as a correction rather than a refusal', async () => {
    pendingGroups = [pendingGroup()]
    route = routed({ intent: 'group_link' })
    await dmService.handle(dm('the group is for Cve 575'))

    await dmService.handle(dm('CVE 577'))
    expect(proposed).toHaveLength(0)
    expect(outbox.at(-1)).toMatch(/CVE 577/)

    await dmService.handle(dm('yes'))
    expect(proposed).toEqual([{ chatJid: '120363430457309406@g.us', course: 'CVE 577' }])
  })

  it('asks again on a no, and relays nothing', async () => {
    pendingGroups = [pendingGroup()]
    route = routed({ intent: 'group_link' })
    await dmService.handle(dm('the group is for Cve 575'))

    await dmService.handle(dm('no'))
    expect(proposed).toHaveLength(0)
    expect(outbox.at(-1)).toMatch(/which course/i)
    expect(conversation!.pendingAction).toBeNull()
  })

  it('says which group it picked when several are waiting', async () => {
    pendingGroups = [pendingGroup(), pendingGroup({ chatJid: '2@g.us', name: 'Dept Notices' })]
    route = routed({ intent: 'group_link' })

    await dmService.handle(dm('the group is for CVE 575'))
    expect(outbox.at(-1)).toMatch(/out of 2 waiting/i)
  })

  it('lets them change the subject instead of answering', async () => {
    pendingGroups = [pendingGroup()]
    route = routed({ intent: 'group_link' })
    await dmService.handle(dm('the group is for CVE 575'))

    route = routed({})
    await dmService.handle(dm('when is the test?'))
    expect(answer).toHaveBeenCalled()
    expect(proposed).toHaveLength(0)
  })
})

function voiceNote(transcript: string): Message {
  return {
    ...dm(''),
    type: 'audio',
    text: null,
    transcript,
    mediaKey: 'audio/incoming',
    mimeType: 'audio/ogg',
  } as Message
}

/**
 * A DM's content can live entirely in its transcript. This broke once: media was read
 * only on the group branch, so a student's recorded question reached the router as an
 * empty string and was answered as though they had sent nothing.
 */
describe('talking to it with a voice note', () => {
  it('asks a question from the transcript alone', async () => {
    route = routed({})
    await dmService.handle(voiceNote('When is the CSC 301 test?'))

    const [question] = answer.mock.calls[0] as unknown as [string]
    expect(question).toBe('When is the CSC 301 test?')
  })

  it('runs a command spoken aloud, punctuation and capitals included', async () => {
    // Whisper returns "Pause until Monday." — the literal matcher has to survive that.
    await dmService.handle(voiceNote('Pause until Monday.'))
    expect(user.pausedUntil).toBeInstanceOf(Date)
    expect(answer).not.toHaveBeenCalled()
  })

  it('says it could not hear rather than answering an empty question', async () => {
    await dmService.handle({ ...dm(''), type: 'audio', text: null } as Message)
    expect(outbox.at(-1)).toMatch(/couldn't make anything out of that/i)
    expect(answer).not.toHaveBeenCalled()
  })
})

/**
 * A voice note the student cannot see transcribed is a black box. "I'm not sure what
 * you're after" leaves them unable to tell a misunderstood request from a misheard
 * word — and a two-second recording is far more often the latter.
 */
describe('when it cannot make sense of a spoken message', () => {
  it('reads back what it heard', async () => {
    route = routed({ confidence: 0.2 })
    await dmService.handle(voiceNote('Uhh, yeah, so'))

    expect(outbox.at(-1)).toMatch(/I heard: _"Uhh, yeah, so"_/)
    expect(outbox.at(-1)).toMatch(/not sure what you're after/i)
  })

  it('does not read typed text back at someone who can already see it', async () => {
    route = routed({ confidence: 0.2 })
    await dmService.handle(dm('hmm'))

    expect(outbox.at(-1)).not.toMatch(/I heard/)
  })
})
