import { getContentType, type WAMessage } from '@whiskeysockets/baileys'
import type { Message, MessageType } from '../models/index.js'
import { isGroupJid, jidToPhone } from './jid.js'

/**
 * Flattens Baileys' nested message union into the one shape the rest of the
 * pipeline reads. Provenance is captured here, at ingest, and never recomputed —
 * every citation downstream is assembled from these fields.
 *
 * In a group `key.remoteJid` is the group, not the person; `key.participant`
 * carries the actual sender.
 */
export function normalize(raw: WAMessage): Message | null {
  const waMessageId = raw.key.id
  const chatJid = raw.key.remoteJid
  if (!waMessageId || !chatJid || !raw.message) return null

  const fromGroup = isGroupJid(chatJid)
  const senderJid = fromGroup ? (raw.key.participant ?? null) : chatJid
  const contentType = getContentType(raw.message)
  const content = contentType ? raw.message[contentType] : undefined
  const media =
    typeof content === 'object' && content !== null ? (content as Record<string, unknown>) : {}

  const text = raw.message.conversation ?? raw.message.extendedTextMessage?.text ?? null

  const contextInfo =
    raw.message.extendedTextMessage?.contextInfo ??
    (media['contextInfo'] as { stanzaId?: string | null } | undefined) ??
    null

  return {
    waMessageId,
    chatJid,
    senderJid,
    senderPhone: senderJid ? jidToPhone(senderJid) : null,
    senderName: raw.pushName ?? null,
    fromGroup,
    timestamp: toDate(raw.messageTimestamp),
    type: toMessageType(contentType),
    text,
    caption: (media['caption'] as string | undefined) ?? null,
    quotedMessageId: contextInfo?.stanzaId ?? null,
    mediaKey: null,
    mimeType: (media['mimetype'] as string | undefined) ?? null,
    fileName: (media['fileName'] as string | undefined) ?? null,
    transcript: null,
    processingStatus: 'pending',
    processingError: null,
    processingAttempts: 0,
    ingestedAt: new Date(),
  }
}

function toDate(timestamp: WAMessage['messageTimestamp']): Date {
  if (!timestamp) return new Date()
  const seconds = typeof timestamp === 'number' ? timestamp : Number(timestamp.toString())
  return new Date(seconds * 1000)
}

function toMessageType(contentType: string | undefined): MessageType {
  switch (contentType) {
    case 'conversation':
    case 'extendedTextMessage':
      return 'text'
    case 'imageMessage':
      return 'image'
    case 'audioMessage':
      return 'audio'
    case 'documentMessage':
    case 'documentWithCaptionMessage':
      return 'document'
    case 'videoMessage':
      return 'video'
    case 'stickerMessage':
      return 'sticker'
    default:
      return 'other'
  }
}

/** A voice note, as opposed to a shared audio file. This is the differentiator's input. */
export function isVoiceNote(raw: WAMessage): boolean {
  return raw.message?.audioMessage?.ptt === true
}
