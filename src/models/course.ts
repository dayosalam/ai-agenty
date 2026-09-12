import { z } from 'zod'

/**
 * What a course code actually means.
 *
 * Students do not say "CVE 575". They say "structural analysis", or "Dr Bello's
 * course", or "the one on Tuesday". Without somewhere to put the title and the
 * lecturer, every one of those is unanswerable — and course matching is on
 * `courseKey`, so a near-miss returns nothing and raises nothing.
 *
 * Assembled from whatever arrives: a photographed timetable carries titles, a group's
 * trusted senders carry lecturers. Nothing here is required.
 */
export const CourseSchema = z.object({
  courseKey: z.string(),
  /** Display form — "CVE 575". */
  code: z.string(),
  title: z.string().nullable().default(null),
  lecturer: z.string().nullable().default(null),
  /** Other ways people refer to it, lowercased. */
  aliases: z.array(z.string()).default([]),
  updatedAt: z.date(),
})
export type Course = z.infer<typeof CourseSchema>
