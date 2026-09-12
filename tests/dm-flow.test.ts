import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Course, Extraction, Group, Message, User } from '../src/models/index.js'
import type { Routed } from '../src/services/router.service.js'

const PHONE = '2348100000000'
const JID = `${PHONE}@s.whatsapp.net`

let user: User
let conversation: Conversation | null = null
let pendingGroups: Group[] = []
let knownCourses: Course[] = []
const outbox: string[] = []
const sentFiles: string[] = []
const proposed: Array<{ chatJid: string; course: string }> = []
const learned: Array<{ courseKey: string; title: string | null }> = []

const extraction: Extraction = {
  eventId: 'evt-1',
  sourceMessageId: 'src-1',
  chatJid: '1@g.us',
  course: 'CSC 301',
  courseKey: 'CSC301',
  scope: 'course' as const,
  eventType: 'test',
  originalDateText: 'Friday',
  date: '2026-09-18',
  time: '10:00',
  venue: 'LG7',
  confidence: 0.9,
  authority: 'lecturer',
  corroboratedBy: [],
  supersededBy: null,
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
  extractionRepository: {
    findByEventId: vi.fn(async () => extraction),
    dueOn: vi.fn(async () => []),
    forCourses: vi.fn(async () => []),
  },
  conversationRepository: {
    find: vi.fn(async () => conversation),
    save: vi.fn(async (next: Conversation) => {
      conversation = next
    }),
    clear: vi.fn(async () => {
      conversation = null
    }),
  },
  courseRepository: {
    forKeys: vi.fn(async () => knownCourses),
    find: vi.fn(async () => knownCourses[0] ?? null),
    enrich: vi.fn(async (courseKey: string, patch: { title?: string | null }) => {
      learned.push({ courseKey, title: patch.title ?? null })
    }),
  },
  scheduleRepository: {
    forStudent: vi.fn(async () => []),
    forCourse: vi.fn(async () => []),
    insertMany: vi.fn(),
    replaceKinds: vi.fn(async () => 0),
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
      return `sent-${outbox.length}`
    }),
    sendDocument: vi.fn(async (_jid: string, _bytes: Buffer, fileName: string) => {
      sentFiles.push(fileName)
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

let webFinds: Array<{ title: string; url: string }> = []
let downloadable = true
vi.mock('../src/services/research.service.js', () => ({
  researchService: {
    documentsFor: vi.fn(async () =>
      webFinds.map((find) => ({ ...find, topic: 'x', extract: null })),
    ),
    download: vi.fn(async () =>
      downloadable ? { bytes: Buffer.from('%PDF-1.4'), fileName: 'notes.pdf' } : null,
    ),
  },
}))
vi.mock('../src/services/openai.client.js', () => ({ getOpenAI: vi.fn() }))

const answer = vi.fn(async (..._args: unknown[]) => 'The CSC 301 test is Friday 10am in LG7.')
vi.mock('../src/services/qa.service.js', () => ({ qaService: { answer } }))

let route: Routed
/** Consumed in order when set, so a two-part message can route differently per half. */
let routeQueue: Routed[] = []
vi.mock('../src/services/router.service.js', () => ({
  routerService: { route: async () => routeQueue.shift() ?? route },
}))

// researchService itself is mocked; this only flips the "can I search?" check that
// gates the offer, which reads the key rather than the service.
process.env['EXA_API_KEY'] ||= 'test-key'

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
    outsideGroup: false,
    newName: null,
    horizon: null,
    correction: null,
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
  routeQueue = []
  webFinds = []
  downloadable = true
  outbox.length = 0
  sentFiles.length = 0
  proposed.length = 0
  learned.length = 0
  pendingGroups = []
  knownCourses = []
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
/**
 * People ask for two things at once. Answering one and telling them to ask again for
 * the other is honest, but it still leaves them to ask again — so the second half is
 * routed and acted on in its own right.
 */
describe('two requests in one message', () => {
  it('answers both halves', async () => {
    routeQueue = [
      routed({ secondRequest: 'send the slides' }),
      // "Send the slides" names no course; the router carries it from what they were
      // just asking about, exactly as it does for any other follow-up.
      routed({ intent: 'request_resources', courseCode: 'CSC 301', courseFromContext: true }),
    ]

    await dmService.handle(dm('when is the test and send the slides?'))
    expect(outbox[0]).toMatch(/CSC301_week4\.pdf/)
    expect(outbox.at(-1)).toMatch(/CSC 301 test is Friday/)
    expect(outbox.at(-1)).not.toMatch(/also asked me to/i)
  })

  /** Guessing at a half-understood second request is worse than admitting to it. */
  it('says what it did not do when the second half is unclear', async () => {
    routeQueue = [routed({ secondRequest: 'send the slides' }), routed({ confidence: 0.2 })]

    await dmService.handle(dm('when is the test and send the slides?'))
    expect(outbox.at(-1)).toMatch(/also asked me to send the slides/i)
  })
})

/**
 * WhatsApp's Reply quotes a specific message. Somebody scrolling back to an alert from
 * Tuesday and replying to it means that one — which is exactly the case the 45-minute
 * context cannot cover, because the whole point is that it is not the current subject.
 */
describe('replying to a specific alert', () => {
  it('answers about the alert they quoted, not the last thing discussed', async () => {
    conversation = {
      phone: PHONE,
      alerts: [{ waMessageId: 'alert-7', eventId: 'evt-1' }],
      turns: [],
      files: [],
      findings: [],
      updatedAt: new Date(),
    } as unknown as Conversation
    route = routed({ intent: 'ask_question', isFollowUp: false })

    await dmService.handle({ ...dm('is it still holding?'), quotedMessageId: 'alert-7' })

    // Third argument is the focus: the event the alert was about.
    expect(answer.mock.calls[0]![2]).toMatchObject({ extraction: { eventId: 'evt-1' } })
  })

  it('ignores a quote of something that was never an alert', async () => {
    route = routed({ intent: 'ask_question', isFollowUp: false })
    await dmService.handle({ ...dm('what about this?'), quotedMessageId: 'not-an-alert' })
    expect(answer.mock.calls[0]![2]).toBeNull()
  })
})

describe('a message with nothing to attach it to', () => {
  /** They expected something to happen. Silence looks like it did. */
  it('says what a stray yes is not an answer to', async () => {
    await dmService.handle(dm('yes'))
    expect(outbox.at(-1)).toMatch(/Yes to what\?/)
  })

  it('leaves an acknowledgement alone', async () => {
    route = routed({ intent: 'smalltalk' })
    await dmService.handle(dm('ok'))
    expect(outbox.at(-1)).not.toMatch(/Yes to what/)
  })

  /** A code typed into a quiet chat is a request about that course, not a search term. */
  it('gives a rundown for a course code on its own', async () => {
    await dmService.handle(dm('CSC 301'))
    expect(outbox.at(-1)).toMatch(/\*CSC 301\*/)
    expect(answer).not.toHaveBeenCalled()
  })

  it('still treats a question that names a course as a question', async () => {
    route = routed({ intent: 'ask_question', courseCode: 'CSC 301' })
    await dmService.handle(dm('when is the CSC 301 test?'))
    expect(answer).toHaveBeenCalled()
  })
})

/**
 * Peermate was added to one group and told to listen there. Answering "have you got
 * the notes?" with something off the internet — unasked and not what their lecturer
 * set — is a different product from the one they agreed to.
 */
describe('material from outside the group', () => {
  it('offers to look rather than looking', async () => {
    route = routed({
      intent: 'request_resources',
      courseCode: 'CSC 301',
      courseFromContext: true,
      outsideGroup: true,
    })
    await dmService.handle(dm('can you send me some external material?'))

    expect(outbox.at(-1)).toMatch(/look outside your group/i)
    expect(outbox.at(-1)).toMatch(/extra reading/i)
    expect(conversation?.pendingAction).toBe('confirm_web_search')
  })

  it('offers when the group has nothing for that course', async () => {
    route = routed({ intent: 'request_resources', courseCode: 'STA 202' })
    await dmService.handle(dm('STA 202 resources'))
    expect(outbox.at(-1)).toMatch(/look outside your group/i)
  })

  /**
   * Nobody photographed a timetable for this course, so the only place its name has
   * ever appeared is the student's own message. Without it the next search falls back
   * to the number, which is what returned a Math 575 review sheet for a
   * transportation engineering course.
   */
  it('takes the course title from their own words when it has none', async () => {
    route = routed({
      intent: 'request_resources',
      courseCode: 'CSC 301',
      courseFromContext: true,
      outsideGroup: true,
    })

    await dmService.handle(dm('get me external material for CSC 301 data structures'))
    expect(learned).toContainEqual({ courseKey: 'CSC301', title: 'data structures' })
  })

  it('never overwrites a title that came from a document', async () => {
    knownCourses = [
      {
        courseKey: 'CSC301',
        code: 'CSC 301',
        title: 'Algorithms and Complexity',
        lecturer: null,
        aliases: [],
        updatedAt: new Date(),
      },
    ]
    route = routed({
      intent: 'request_resources',
      courseCode: 'CSC 301',
      courseFromContext: true,
      outsideGroup: true,
    })

    await dmService.handle(dm('external material for CSC 301 data structures'))
    expect(learned).toHaveLength(0)
  })

  it('takes no for an answer', async () => {
    route = routed({
      intent: 'request_resources',
      courseCode: 'CSC 301',
      courseFromContext: true,
      outsideGroup: true,
    })
    await dmService.handle(dm('find me something online'))
    await dmService.handle(dm('no'))

    expect(outbox.at(-1)).toMatch(/stick to what your group shares/i)
    expect(conversation?.pendingAction).toBeNull()
  })

  it('lists what it found, labelled, and sends nothing yet', async () => {
    webFinds = [
      { title: 'Intro to Algorithms notes', url: 'https://example.edu/a.pdf' },
      { title: 'Past questions 2023', url: 'https://example.edu/b.pdf' },
    ]
    route = routed({
      intent: 'request_resources',
      courseCode: 'CSC 301',
      courseFromContext: true,
      outsideGroup: true,
    })

    await dmService.handle(dm('any external material?'))
    await dmService.handle(dm('yes'))

    expect(outbox.at(-1)).toMatch(/Found 2 PDFs/)
    expect(outbox.at(-1)).toMatch(/not from your group/i)
    expect(sentFiles).toHaveLength(0)
    expect(conversation?.pendingAction).toBe('choose_web_file')
  })

  it('sends the one they picked', async () => {
    webFinds = [
      { title: 'Intro to Algorithms notes', url: 'https://example.edu/a.pdf' },
      { title: 'Past questions 2023', url: 'https://example.edu/b.pdf' },
    ]
    route = routed({
      intent: 'request_resources',
      courseCode: 'CSC 301',
      courseFromContext: true,
      outsideGroup: true,
    })

    await dmService.handle(dm('external material please'))
    await dmService.handle(dm('yes'))
    await dmService.handle(dm('2'))

    expect(sentFiles).toEqual(['notes.pdf'])
  })

  /** A .pdf URL is a claim. What comes back is as often a login wall. */
  it('names what it could not download rather than counting it', async () => {
    webFinds = [{ title: 'Past questions 2023', url: 'https://example.edu/b.pdf' }]
    downloadable = false
    route = routed({
      intent: 'request_resources',
      courseCode: 'CSC 301',
      courseFromContext: true,
      outsideGroup: true,
    })

    await dmService.handle(dm('external material please'))
    await dmService.handle(dm('yes'))
    await dmService.handle(dm('1'))

    expect(sentFiles).toHaveLength(0)
    expect(outbox.at(-1)).toMatch(/couldn't download \*Past questions 2023\*/)
  })

  it('does not read an ordinary question as picking from the list', async () => {
    webFinds = [{ title: 'Notes', url: 'https://example.edu/a.pdf' }]
    route = routed({
      intent: 'request_resources',
      courseCode: 'CSC 301',
      courseFromContext: true,
      outsideGroup: true,
    })

    await dmService.handle(dm('external material please'))
    await dmService.handle(dm('yes'))

    route = routed({ intent: 'ask_question', courseCode: 'CSC 301' })
    await dmService.handle(dm('when is the CSC 301 test?'))

    expect(sentFiles).toHaveLength(0)
    expect(answer).toHaveBeenCalled()
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

/**
 * The regression: "is there any material for the course?" was answered with "you're
 * not watching CSC 301". The router's own prompt is dense with example codes, and
 * asked to fill a courseCode slot for a message naming no course it returned one of
 * them. Confirmed against the live model — with no context it invents CSC 301, and it
 * has also returned "/" as a course code.
 */
describe('a course code the student never typed', () => {
  it('is ignored rather than answered about', async () => {
    route = routed({ intent: 'request_resources', courseCode: 'CSC 301' })
    await dmService.handle(dm('is there any material for the course ?'))

    expect(outbox.at(-1)).not.toMatch(/not watching/i)
    expect(outbox.at(-1)).toMatch(/Which course/i)
  })

  it('still corrects a student who really did type a course they dropped', async () => {
    route = routed({ intent: 'ask_question', courseCode: 'MTH 101' })
    await dmService.handle(dm('when is the MTH 101 test?'))

    expect(outbox.at(-1)).toMatch(/not watching \*MTH 101\*/i)
  })

  it('takes the course from context when the message names none', async () => {
    await conversationService.rememberCourse(PHONE, 'STA202')

    route = routed({ intent: 'ask_question', courseCode: null })
    await dmService.handle(dm('is there any material for the course ?'))

    const [, scope] = answer.mock.calls[0] as unknown as [string, string[]]
    expect(scope).toEqual(['STA202'])
  })
})
