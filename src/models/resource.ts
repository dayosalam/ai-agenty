import { z } from 'zod'

export const DocType = z.enum(['slides', 'past_questions', 'assignment', 'textbook', 'other'])
export type DocType = z.infer<typeof DocType>

export const ResourceSchema = z.object({
  course: z.string().nullable(),
  courseKey: z.string().nullable(),
  docType: DocType,
  fileName: z.string(),
  mediaKey: z.string(),
  mimeType: z.string().nullable(),
  postedBy: z.string().nullable(),
  postedAt: z.date(),
  sourceMessageId: z.string(),
})
export type Resource = z.infer<typeof ResourceSchema>
