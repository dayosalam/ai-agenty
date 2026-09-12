import { z } from 'zod'

export const MessageType = z.enum([
  'text',
  'image',
  'audio',
  'document',
  'video',
  'sticker',
  'other',
])
export type MessageType = z.infer<typeof MessageType>

export const ProcessingStatus = z.enum(['pending', 'processing', 'done', 'failed', 'skipped'])
export type ProcessingStatus = z.infer<typeof ProcessingStatus>

/**
 * The contract. Every downstream stage reads this shape, and every citation is
 * assembled from the provenance fields, never from the model's own words.
 */
export const MessageSchema = z.object({
  waMessageId: z.string(),
  chatJid: z.string(),
  senderJid: z.string().nullable(),
  senderPhone: z.string().nullable(),
  senderName: z.string().nullable(),
  fromGroup: z.boolean(),
  timestamp: z.date(),
  type: MessageType,
  text: z.string().nullable(),
  caption: z.string().nullable(),
  quotedMessageId: z.string().nullable(),
  mediaKey: z.string().nullable(),
  mimeType: z.string().nullable(),
  fileName: z.string().nullable(),
  transcript: z.string().nullable(),
  processingStatus: ProcessingStatus,
  processingError: z.string().nullable().default(null),
  /** How many times the pipeline has thrown on this message. Caps automatic retries. */
  processingAttempts: z.number().default(0),
  ingestedAt: z.date(),
})
export type Message = z.infer<typeof MessageSchema>
