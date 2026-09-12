import { z } from 'zod'

export const RememberedFileSchema = z.object({
  position: z.number(),
  fileName: z.string(),
  mediaKey: z.string(),
  mimeType: z.string().nullable(),
  courseKey: z.string().nullable(),
})
export type RememberedFile = z.infer<typeof RememberedFileSchema>

/**
 * What the last exchange was about.
 *
 * Without this every DM is a first message, and the follow-ups people actually send
 * — "where is it?", "who said that?", "send the second one", "what about STA?" —
 * have no referent. They are not lazy phrasing; they are how conversation works.
 *
 * Deliberately small and short-lived: enough to resolve a pronoun, not a transcript.
 */
export const ConversationSchema = z.object({
  phone: z.string(),
  /** "that course", and the default for a question that names none. */
  courseKey: z.string().nullable().default(null),
  /** "where is it?", "what time?" — the event just discussed. */
  eventId: z.string().nullable().default(null),
  /** "who said that?", "what did he say exactly?" */
  sourceMessageId: z.string().nullable().default(null),
  /** "send the second one", "send all" — what was just listed. */
  files: z.array(RememberedFileSchema).default([]),
  /** "repeat that". */
  lastAnswer: z.string().nullable().default(null),
  lastQuestion: z.string().nullable().default(null),
  /**
   * A command still waiting on one word back: a confirmation before anything is
   * destroyed, or the name they were asked for. Kept here rather than on the user so
   * an abandoned half-command expires with the rest of the context instead of
   * capturing an unrelated message an hour later.
   */
  pendingAction: z
    .enum(['confirm_wipe', 'awaiting_name', 'awaiting_resource_course'])
    .nullable()
    .default(null),
  updatedAt: z.date(),
})
export type Conversation = z.infer<typeof ConversationSchema>
