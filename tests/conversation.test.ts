import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, Extraction, Message } from '../src/models/index.js'

const PHONE = '2348100000000'
let stored: Conversation | null = null

const extraction = {
  eventId: 'evt-1',
  sourceMessageId: 'src-1',
  courseKey: 'CSC301',
  course: 'CSC 301',
  eventType: 'test',
  venue: 'LG7',
  time: '10:00',
  corroboratedBy: [],
} as unknown as Extraction

vi.mock('../src/repositories/index.js', () => ({
  conversationRepository: {
    find: vi.fn(async () => stored),
    save: vi.fn(async (next: Conversation) => {
      stored = next
    }),
    clear: vi.fn(async () => {
      stored = null
    }),
  },
  extractionRepository: { findByEventId: vi.fn(async () => extraction) },
  messageRepository: { findById: vi.fn(async () => ({ senderName: 'Dr Bello' }) as Message) },
}))

const { conversationService } = await import('../src/services/conversation.service.js')

const age = (minutes: number): void => {
  if (stored) stored.updatedAt = new Date(Date.now() - minutes * 60 * 1000)
}

beforeEach(() => {
  stored = null
})

describe('what the last exchange was about', () => {
  it('keeps the course, the event and the files it listed', async () => {
    await conversationService.rememberEvent(PHONE, extraction)
    const focus = await conversationService.focus(PHONE)
    expect(focus?.extraction.eventId).toBe('evt-1')
    expect(focus?.source?.senderName).toBe('Dr Bello')
  })

  it('merges rather than overwrites', async () => {
    await conversationService.rememberEvent(PHONE, extraction)
    await conversationService.rememberQuestion(PHONE, 'where is it?', 'LG7.')

    const summary = await conversationService.summarise(PHONE)
    expect(summary).toMatch(/CSC 301/)
    expect(summary).toMatch(/where is it/)
    expect(summary).toMatch(/I last told them/)
    expect((await conversationService.focus(PHONE))?.extraction.eventId).toBe('evt-1')
  })

  /**
   * Stale context is worse than none. A pronoun resolved against something discussed
   * an hour ago produces a confident answer about the wrong event, and the student
   * has no way to tell.
   */
  it('forgets rather than answering against something an hour old', async () => {
    await conversationService.rememberEvent(PHONE, extraction)
    age(60)

    expect(await conversationService.get(PHONE)).toBeNull()
    expect(await conversationService.focus(PHONE)).toBeNull()
    expect(await conversationService.summarise(PHONE)).toBeNull()
    expect(await conversationService.lastAnswer(PHONE)).toBeNull()
  })

  it('still remembers inside the window', async () => {
    await conversationService.rememberEvent(PHONE, extraction)
    age(20)
    expect(await conversationService.focus(PHONE)).not.toBeNull()
  })

  it('drops a stale pending command instead of applying it to a new message', async () => {
    await conversationService.expect(PHONE, 'confirm_wipe')
    age(60)
    expect((await conversationService.get(PHONE))?.pendingAction).toBeUndefined()
  })

  it('numbers the files it listed, so "send the second one" means something', async () => {
    await conversationService.rememberFiles(PHONE, [
      { fileName: 'a.pdf', mediaKey: 'k1', mimeType: null, courseKey: 'CSC301' },
      { fileName: 'b.pdf', mediaKey: 'k2', mimeType: null, courseKey: 'CSC301' },
    ] as never)

    const summary = await conversationService.summarise(PHONE)
    expect(summary).toMatch(/1\. a\.pdf/)
    expect(summary).toMatch(/2\. b\.pdf/)
  })
})
