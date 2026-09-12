import type { WAMessage } from '@whiskeysockets/baileys'
import { describe, expect, it } from 'vitest'
import { isVoiceNote, normalize } from '../src/whatsapp/normalizer.js'

const GROUP = '120363000000000000@g.us'
const SENDER = '2348012345678@s.whatsapp.net'

function wa(over: Record<string, unknown>): WAMessage {
  return {
    key: { id: 'ABC123', remoteJid: GROUP, participant: SENDER, fromMe: false },
    messageTimestamp: 1789000000,
    pushName: 'Dr. Bello',
    ...over,
  } as unknown as WAMessage
}

/**
 * The normalizer is the provenance contract: every citation downstream is built from
 * what it captures here, and nothing recomputes it later.
 */
describe('normalize', () => {
  it('takes the sender from participant, not remoteJid, in a group', () => {
    // remoteJid is the group. Reading it as the sender would attribute every
    // announcement in CSC 301 to "CSC 301".
    const message = normalize(wa({ message: { conversation: 'CSC 301 test Friday' } }))!
    expect(message.chatJid).toBe(GROUP)
    expect(message.senderJid).toBe(SENDER)
    expect(message.senderPhone).toBe('2348012345678')
    expect(message.fromGroup).toBe(true)
  })

  it('treats a DM as its own sender', () => {
    const message = normalize(
      wa({ key: { id: 'X', remoteJid: SENDER, fromMe: false }, message: { conversation: 'hi' } }),
    )!
    expect(message.fromGroup).toBe(false)
    expect(message.senderJid).toBe(SENDER)
  })

  it('captures the fields a citation is made of', () => {
    const message = normalize(wa({ message: { conversation: 'test' } }))!
    expect(message.waMessageId).toBe('ABC123')
    expect(message.senderName).toBe('Dr. Bello')
    expect(message.timestamp.getTime()).toBe(1789000000 * 1000)
  })

  it('reads extended text and its quoted message id', () => {
    const message = normalize(
      wa({
        message: {
          extendedTextMessage: {
            text: 'No, it is LG8',
            contextInfo: { stanzaId: 'ORIGINAL1' },
          },
        },
      }),
    )!
    expect(message.text).toBe('No, it is LG8')
    expect(message.quotedMessageId).toBe('ORIGINAL1')
    expect(message.type).toBe('text')
  })

  it('maps media types and keeps the filename a document is tagged by', () => {
    const document = normalize(
      wa({
        message: {
          documentMessage: {
            fileName: 'CSC301_wk3_slides.pdf',
            mimetype: 'application/pdf',
            caption: 'week 3',
          },
        },
      }),
    )!
    expect(document.type).toBe('document')
    expect(document.fileName).toBe('CSC301_wk3_slides.pdf')
    expect(document.mimeType).toBe('application/pdf')
    expect(document.caption).toBe('week 3')

    expect(normalize(wa({ message: { imageMessage: {} } }))!.type).toBe('image')
    expect(normalize(wa({ message: { audioMessage: {} } }))!.type).toBe('audio')
    expect(normalize(wa({ message: { stickerMessage: {} } }))!.type).toBe('sticker')
  })

  it('arrives pending with no transcript, so the worker owns those', () => {
    const message = normalize(wa({ message: { audioMessage: { ptt: true } } }))!
    expect(message.processingStatus).toBe('pending')
    expect(message.transcript).toBeNull()
    expect(message.mediaKey).toBeNull()
    // Attempts start at zero so the automatic retry cap counts from a clean slate.
    expect(message.processingAttempts).toBe(0)
  })

  it('returns null for a message with no content to store', () => {
    expect(normalize(wa({ message: undefined }))).toBeNull()
    expect(normalize(wa({ key: { id: null, remoteJid: GROUP }, message: {} }))).toBeNull()
  })
})

describe('isVoiceNote', () => {
  it('separates a voice note from a shared audio file', () => {
    expect(isVoiceNote(wa({ message: { audioMessage: { ptt: true } } }))).toBe(true)
    expect(isVoiceNote(wa({ message: { audioMessage: { ptt: false } } }))).toBe(false)
    expect(isVoiceNote(wa({ message: { conversation: 'hi' } }))).toBe(false)
  })
})
