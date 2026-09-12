import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Extraction, Message, User } from '../src/models/index.js'
import type { Routed } from '../src/services/router.service.js'

const PHONE = '2348100000000'
const JID = `${PHONE}@s.whatsapp.net`

let user: User
let conversation: Conversation | null = null
const outbox: string[] = []
const sentFiles: string[] = []

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
  groupRepository: { approved: vi.fn(async () => []), pending: vi.fn(async () => []) },
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
