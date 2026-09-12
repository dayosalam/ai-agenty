import { z } from 'zod'

export const EventType = z.enum([
  'test',
  'assignment',
  'lecture',
  'meeting',
  'venue_change',
  'deadline',
])
export type EventType = z.infer<typeof EventType>

export const AnnouncementSchema = z.object({
  course: z.string().nullable(),
  eventType: EventType,
  originalDateText: z.string().nullable(),
  date: z.string().nullable(),
  time: z.string().nullable(),
  venue: z.string().nullable(),
  confidence: z.number().min(0).max(1),
})
export type Announcement = z.infer<typeof AnnouncementSchema>

/**
 * The tagged union, verdict first. The model commits to `kind` before it sees any
 * event fields, which is what stops noise becoming a phantom announcement. Do not
 * flatten this into nullable fields — see PRD §8.
 */
export const ExtractionResultSchema = z.object({
  kind: z.enum(['announcement', 'question', 'noise']),
  announcements: z.array(AnnouncementSchema).default([]),
})
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>

/** One row per announcement. Append-only: a correction is a new row. */
export const ExtractionSchema = AnnouncementSchema.extend({
  /**
   * Identifies the event, not the message.
   *
   * One voice note can carry two deadlines, and both rows share a source message id
   * — so deduping notifications on that id silently suppresses the second warning.
   */
  eventId: z.string(),
  sourceMessageId: z.string(),
  /** Whose word this is. Decides whether a repeat is an update or just backing. */
  authority: z.enum(['lecturer', 'rep', 'student']).default('student'),
  /** Source message ids that said the same thing after this one. */
  corroboratedBy: z.array(z.string()).default([]),
  chatJid: z.string(),
  courseKey: z.string().nullable(),
  extractedAt: z.date(),
})
export type Extraction = z.infer<typeof ExtractionSchema>
