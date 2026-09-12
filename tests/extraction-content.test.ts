import { describe, expect, it } from 'vitest'
import type { Message } from '../src/models/index.js'
import { ExtractionService } from '../src/services/extraction.service.js'

/** readableContent is private by design; this is the same path classify() takes. */
const service = new ExtractionService()
const readable = (message: Message, context = { defaultCourse: 'CVE 575' }): string | null =>
  (Reflect.get(service, 'readableContent') as (m: Message, c: unknown) => string | null).call(
    service,
    message,
    context,
  )

function message(over: Partial<Message>): Message {
  return {
    waMessageId: 'X',
    chatJid: '120363000000000000@g.us',
    senderJid: '111@lid',
    senderPhone: null,
    senderName: 'salami.dev',
    fromGroup: true,
    timestamp: new Date(),
    type: 'text',
    text: null,
    caption: null,
    quotedMessageId: null,
    mediaKey: null,
    mimeType: null,
    fileName: null,
    transcript: null,
    processingStatus: 'pending',
    processingError: null,
    processingAttempts: 0,
    ingestedAt: new Date(),
    ...over,
  } as Message
}

/**
 * The regression this exists for: five class-notes PDFs posted with no caption
 * produced five "CVE 575 test — tomorrow 4pm" alerts at 0.9 confidence, one with a
 * venue of "/dev/null". The model had been handed nothing but a filename.
 */
describe('what the extractor is allowed to read', () => {
  it('refuses a file with no words about it', () => {
    const silent = message({
      type: 'document',
      fileName: 'Unilorin_CVE575_ClassNotes.pdf',
      caption: '',
      mimeType: 'application/pdf',
    })
    expect(readable(silent)).toBeNull()
  })

  it('refuses a photo or voice note that could not be read', () => {
    expect(readable(message({ type: 'image', mediaKey: 'image/x' }))).toBeNull()
    expect(readable(message({ type: 'audio', mediaKey: 'audio/x', transcript: null }))).toBeNull()
  })

  it('refuses a sticker', () => {
    expect(readable(message({ type: 'sticker' }))).toBeNull()
  })

  it('accepts a file when someone actually said something about it', () => {
    const captioned = message({
      type: 'document',
      fileName: 'brief.pdf',
      caption: 'CVE 575 assignment brief, due Thursday',
    })
    const content = readable(captioned)
    expect(content).toContain('due Thursday')
    expect(content).toContain('brief.pdf')
  })

  it('never lets context stand in for a body', () => {
    // Preceding messages exist to disambiguate a file, not to become the announcement.
    const noBody = message({ type: 'document', fileName: 'notes.pdf' })
    expect(
      readable(noBody, {
        defaultCourse: 'CVE 575',
        precedingTexts: ['test is on Friday'],
        quotedText: 'the venue is LG7',
      } as never),
    ).toBeNull()
  })

  it('reads a transcript as the body, since that is what was said', () => {
    const voice = message({
      type: 'audio',
      transcript: 'The CVE 575 test has moved to Monday 8am.',
    })
    expect(readable(voice)).toContain('moved to Monday')
  })
})
