import { z } from 'zod'

export const ScheduleKind = z.enum(['exam', 'test', 'lecture', 'tutorial', 'practical'])
export type ScheduleKind = z.infer<typeof ScheduleKind>

/**
 * A student's own timetable, from a photograph they sent.
 *
 * Deliberately separate from `extractions`. An extraction is something somebody said
 * in a group, attributable and shared with everyone on the course. This is one
 * student's private copy of their schedule: it may list courses nobody else takes,
 * it may be a draft, and its dates come from OCR of their handwriting. Broadcasting
 * it would make one student's misread photograph into the whole class's exam date.
 */
export const ScheduleEntrySchema = z.object({
  phone: z.string(),
  course: z.string().nullable(),
  courseKey: z.string().nullable(),
  kind: ScheduleKind,
  /** Set for one-off events — an exam on a named date. */
  date: z.string().nullable().default(null),
  /**
   * Set for anything weekly. 0 = Sunday, matching Date.getDay(), so a lecture
   * recurs without a row per week for the rest of the semester.
   */
  weekday: z.number().min(0).max(6).nullable().default(null),
  /** 24-hour, because it sorts and compares. Students always read 12-hour. */
  time: z.string().nullable().default(null),
  venue: z.string().nullable().default(null),
  /** The photograph this came out of, so a wrong entry can be traced back. */
  sourceMessageId: z.string(),
  createdAt: z.date(),
})
export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>
