import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '../src/models/index.js'

let doc: Conversation | null = null

vi.mock('../src/repositories/index.js', () => ({
  conversationRepository: {
    find: vi.fn(async () => doc),
    save: vi.fn(async (conversation: Conversation) => {
      doc = conversation
    }),
    clear: vi.fn(async () => {
      doc = null
    }),
  },
  extractionRepository: { findByEventId: vi.fn(async () => null) },
  messageRepository: { findById: vi.fn(async () => null) },
}))

const { conversationService } = await import('../src/services/conversation.service.js')

const PHONE = '2348012345678'

beforeEach(() => {
  doc = null
})

/**
 * Without a thread every message is a first message. "You said Thursday", "the one you
 * mentioned", "what did I ask you yesterday?" are all unanswerable, and the honest
 * failure — admitting the gap — is still a failure the student notices immediately.
 */
describe('remembering the thread', () => {
  it('keeps both sides, oldest first', async () => {
    await conversationService.rememberTurn(PHONE, 'student', 'when is the CVE 575 test?')
    await conversationService.rememberTurn(PHONE, 'peermate', 'Thursday 10am, LG7.')
    await conversationService.rememberTurn(PHONE, 'student', 'where again?')

    expect(doc?.turns.map((turn) => turn.role)).toEqual(['student', 'peermate', 'student'])
    expect(doc?.turns[0]!.text).toBe('when is the CVE 575 test?')
  })

  it('keeps at least twenty exchanges, dropping the oldest first', async () => {
    for (let index = 0; index < 30; index += 1) {
      await conversationService.rememberTurn(PHONE, 'student', `question ${index}`)
      await conversationService.rememberTurn(PHONE, 'peermate', `answer ${index}`)
    }

    expect(doc!.turns.length).toBe(40)
    expect(doc!.turns[0]!.text).toBe('question 10')
    expect(doc!.turns.at(-1)!.text).toBe('answer 29')
  })

  it('ignores an empty turn rather than storing a blank line', async () => {
    await conversationService.rememberTurn(PHONE, 'student', '   ')
    expect(doc).toBeNull()
  })

  /**
   * The referents expire because a stale "it" answers about the wrong event. A
   * transcript cannot be wrong that way — it is only ever a record of what was said —
   * and wiping it with them is what made every conversation start from nothing.
   */
  it('survives the staleness that clears the referents', async () => {
    await conversationService.rememberTurn(PHONE, 'student', 'when is the CVE 575 test?')
    await conversationService.rememberQuestion(PHONE, 'when is the test?', 'Thursday 10am.')

    doc = { ...doc!, updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) }
    await conversationService.touch(PHONE)

    expect(doc!.lastAnswer).toBeNull()
    expect(doc!.turns).toHaveLength(1)
    expect(await conversationService.transcript(PHONE, 20, 400)).toMatch(/CVE 575 test/)
  })

  it('forgets everything when they ask it to', async () => {
    await conversationService.rememberTurn(PHONE, 'student', 'hello')
    await conversationService.forget(PHONE)
    expect(await conversationService.transcript(PHONE, 20, 400)).toBeNull()
  })
})

describe('the thread as a prompt block', () => {
  it('says who said what, newest last', async () => {
    await conversationService.rememberTurn(PHONE, 'student', 'when is the test?')
    await conversationService.rememberTurn(PHONE, 'peermate', 'Thursday 10am, LG7.')

    const lines = (await conversationService.transcript(PHONE, 20, 400))!.split('\n')
    expect(lines[0]).toMatch(/They said: when is the test\?$/)
    expect(lines[1]).toMatch(/I replied: Thursday 10am, LG7\.$/)
    // Stamped, so a model can tell a three-day-old exchange from one just had.
    expect(lines[0]).toMatch(/^\[\d+ \w{3,4}, \d+:\d{2}\s?[ap]m\]/i)
  })

  it('returns only the last few when that is all the caller wants', async () => {
    for (const word of ['one', 'two', 'three', 'four']) {
      await conversationService.rememberTurn(PHONE, 'student', word)
    }
    const lines = (await conversationService.transcript(PHONE, 2, 400))!.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(/four/)
  })

  /** A digest runs to hundreds of words; forty of them would crowd out the question. */
  it('clips a long turn instead of carrying the whole thing', async () => {
    await conversationService.rememberTurn(PHONE, 'peermate', 'x'.repeat(900))
    expect(doc!.turns[0]!.text.length).toBeLessThan(600)

    const line = (await conversationService.transcript(PHONE, 20, 50))!
    expect(line.length).toBeLessThan(120)
    expect(line).toMatch(/…$/)
  })

  it('flattens a multi-line reply onto one line', async () => {
    await conversationService.rememberTurn(PHONE, 'peermate', 'Thursday 10am\n\nLG7')
    expect(await conversationService.transcript(PHONE, 20, 400)).toMatch(/Thursday 10am LG7/)
  })
})
