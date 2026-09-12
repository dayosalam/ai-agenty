import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, User } from '../src/models/index.js'

let stored: User | null = null

vi.mock('../src/repositories/index.js', () => ({
  userRepository: {
    findByPhone: vi.fn(async () => stored),
    upsert: vi.fn(async (user: User) => {
      stored = user
    }),
  },
  groupRepository: { approved: vi.fn(async () => []) },
}))

const { onboardingService } = await import('../src/services/onboarding.service.js')

const PHONE = '2348100000000'

function said(text: string, over: Partial<Message> = {}): Message {
  return {
    waMessageId: `m-${Math.random()}`,
    chatJid: `${PHONE}@s.whatsapp.net`,
    senderJid: `${PHONE}@s.whatsapp.net`,
    senderPhone: PHONE,
    senderName: 'Amina Bello',
    fromGroup: false,
    timestamp: new Date(),
    type: 'text',
    text,
    caption: null,
    quotedMessageId: null,
    mediaKey: null,
    mimeType: null,
    fileName: null,
    transcript: null,
    processingStatus: 'done',
    processingError: null,
    processingAttempts: 0,
    ingestedAt: new Date(),
    ...over,
  } as Message
}

const reply = (text: string, over?: Partial<Message>): Promise<string | null> =>
  onboardingService.handle(said(text, over))

beforeEach(() => {
  stored = null
})

describe('registering, start to finish', () => {
  it('walks name, courses, digest and ends registered', async () => {
    expect(await reply('hi')).toMatch(/what should I call you/i)
    expect(await reply('Amina')).toMatch(/Which courses/i)

    const confirmed = await reply('CSC 301, STA 202')
    expect(confirmed).toMatch(/CSC 301/)
    expect(confirmed).toMatch(/STA 202/)
    expect(stored!.courseKeys).toEqual(['CSC301', 'STA202'])

    const welcome = await reply('6am voice')
    expect(welcome).toMatch(/all set/i)
    expect(stored!.onboardingState).toBe('registered')
    expect(stored!.digestHour).toBe(6)
    expect(stored!.digestFormat).toBe('voice')
  })

  it('skips ahead when they open with their course list', async () => {
    await reply('CSC 301 and MTH 101')
    expect(stored!.onboardingState).toBe('awaiting_digest')
    expect(stored!.courseKeys).toEqual(['CSC301', 'MTH101'])
  })

  it('falls back to the WhatsApp profile name on skip, rather than naming them Skip', async () => {
    await reply('hi')
    await reply('skip')
    expect(stored!.displayName).toBe('Amina Bello')
    expect(stored!.onboardingState).toBe('awaiting_courses')
  })

  it('reads a name out of a sentence', async () => {
    await reply('hi')
    await reply("i'm chidi")
    expect(stored!.displayName).toBe('Chidi')
  })

  it('says which default it took when the digest answer is not a time', async () => {
    await reply('CSC 301')
    const welcome = await reply('after breakfast')
    expect(welcome).toMatch(/couldn't read a time/i)
    expect(stored!.digestHour).toBe(7)
  })

  it('goes back a step and starts over on request', async () => {
    await reply('hi')
    await reply('Amina')
    expect(await reply('back')).toMatch(/what should I call you/i)
    expect(stored!.onboardingState).toBe('awaiting_name')

    await reply('Amina')
    await reply('CSC 301')
    expect(await reply('restart')).toMatch(/starting over/i)
    expect(stored!.courseKeys).toEqual([])
  })
})

/**
 * The regression this exists for: "cancel" was checked before the state switch, so a
 * fully registered student typing it lost their name, their courses and their
 * settings without ever being asked.
 */
describe('once registered, onboarding is finished with them', () => {
  it('leaves a registered student alone', async () => {
    await reply('CSC 301')
    await reply('7am')
    const before = { ...stored! }

    expect(await reply('cancel')).toBeNull()
    expect(await reply('restart')).toBeNull()
    expect(await reply('back')).toBeNull()
    expect(stored!.courseKeys).toEqual(before.courseKeys)
    expect(stored!.onboardingState).toBe('registered')
  })
})

/**
 * People arrive already wanting something. Taking "when is the CSC 301 test?" as
 * their name, or answering it with "what should I call you?" and nothing else, reads
 * as not having listened.
 */
describe('a question asked during registration', () => {
  it('is acknowledged before the first question is asked', async () => {
    const first = await reply('when is the CSC 301 test?')
    expect(first).toMatch(/when is the CSC 301 test/i)
    expect(first).toMatch(/what should I call you/i)
  })

  it('is acknowledged at the name step without being taken as a name', async () => {
    await reply('hello')
    const answer = await reply('do you know what was announced today?')
    expect(answer).toMatch(/what should I call you/i)
    expect(stored!.displayName).toBeNull()
  })

  it('is acknowledged at the courses step', async () => {
    await reply('hi')
    await reply('Amina')
    const answer = await reply('can you read my WhatsApp messages?')
    expect(answer).toMatch(/can you read my WhatsApp messages/i)
    expect(answer).toMatch(/Which courses/i)
  })

  it('does not mistake a one-word name for a question', async () => {
    await reply('hi')
    await reply('Will')
    expect(stored!.displayName).toBe('Will')
    expect(stored!.onboardingState).toBe('awaiting_courses')
  })

  it('does not mistake a digest preference for a question', async () => {
    await reply('CSC 301')
    await reply('can I get it at 6am?')
    expect(stored!.digestHour).toBe(6)
    expect(stored!.onboardingState).toBe('registered')
  })
})
