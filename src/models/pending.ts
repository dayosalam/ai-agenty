import { z } from 'zod'

/**
 * An announcement Peermate heard but could not route.
 *
 * It knows something was said, and that it matters, but not to whom — the group has
 * no default course and the message never named one. Storing the question lets the
 * operator answer it later in the same DM thread, instead of the announcement being
 * lost the moment the notification scrolls away.
 */
export const PendingDecisionSchema = z.object({
  eventId: z.string(),
  sourceMessageId: z.string(),
  chatJid: z.string(),
  groupName: z.string().nullable(),
  /** What was heard, already formatted for the operator to read. */
  summary: z.string(),
  status: z.enum(['open', 'resolved', 'ignored']),
  askedAt: z.date(),
  resolvedAt: z.date().nullable(),
  resolvedCourse: z.string().nullable(),
})

export type PendingDecision = z.infer<typeof PendingDecisionSchema>
