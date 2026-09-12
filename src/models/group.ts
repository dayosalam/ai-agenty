import { z } from 'zod'

/**
 * Anybody can add the bot to any group, so being in one is not permission to read
 * it. A group ingests nothing until the operator approves it — see PRD §7.
 */
export const GroupStatus = z.enum(['pending', 'approved', 'ignored'])
export type GroupStatus = z.infer<typeof GroupStatus>

/**
 * How much weight a sender's word carries.
 *
 * A lecturer stating a date settles it. A class rep relaying one is close behind.
 * A classmate is corroboration — worth recording, not worth a second alert saying
 * the same thing.
 */
export const Authority = z.enum(['lecturer', 'rep', 'student'])
export type Authority = z.infer<typeof Authority>

export const TrustedSenderSchema = z.object({
  /** Matched on pushName, since group participants now arrive as opaque LIDs. */
  name: z.string(),
  jid: z.string().nullable().default(null),
  role: Authority,
})
export type TrustedSender = z.infer<typeof TrustedSenderSchema>

export const GroupSchema = z.object({
  chatJid: z.string(),
  name: z.string().nullable(),
  defaultCourse: z.string().nullable(),
  defaultCourseKey: z.string().nullable(),
  status: GroupStatus.default('pending'),
  /** Who added Peermate, so the operator knows whose request they are answering. */
  addedBy: z.string().nullable().default(null),
  addedByName: z.string().nullable().default(null),
  participantCount: z.number().nullable().default(null),
  trustedSenders: z.array(TrustedSenderSchema).default([]),
  /**
   * What a student said this group is for.
   *
   * The person who adds Peermate knows the group; the operator decides. Recording
   * the proposal means that knowledge is not lost between the two.
   */
  proposedCourse: z.string().nullable().default(null),
  proposedBy: z.string().nullable().default(null),
  joinedAt: z.date(),
  approvedAt: z.date().nullable().default(null),
})
export type Group = z.infer<typeof GroupSchema>
