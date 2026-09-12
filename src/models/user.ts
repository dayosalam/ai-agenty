import { z } from 'zod'

export const OnboardingState = z.enum([
  'awaiting_name',
  'awaiting_courses',
  'awaiting_digest',
  'registered',
])
export type OnboardingState = z.infer<typeof OnboardingState>

export const DigestFormat = z.enum(['text', 'voice'])
export type DigestFormat = z.infer<typeof DigestFormat>

export const UserSchema = z.object({
  phone: z.string(),
  jid: z.string(),
  /** WhatsApp's pushName — whatever their profile says. */
  name: z.string().nullable(),
  /** What they asked to be called. Used in every message Peermate sends them. */
  displayName: z.string().nullable(),
  courseKeys: z.array(z.string()).default([]),
  onboardingState: OnboardingState,
  registeredAt: z.date().nullable(),
  lastDigestAt: z.date().nullable(),

  /** Voice notes carry the digest well; everything else stays text — see PRD §8. */
  digestFormat: DigestFormat.default('text'),
  /** Hour of the day, in the digest timezone. */
  digestHour: z.number().min(0).max(23).default(7),
  /**
   * Instant alerts are suppressed inside this window. Nothing is lost: the digest
   * covers everything since it last ran, so a held announcement simply arrives in
   * the morning instead of at 2am.
   */
  quietFrom: z.number().min(0).max(23).nullable().default(22),
  quietTo: z.number().min(0).max(23).nullable().default(6),

  /**
   * A pause a student asked for. Nothing is discarded while it holds — the digest
   * covers the window, so a pause defers rather than deletes.
   */
  pausedUntil: z.date().nullable().default(null),
  /** Paused with no end named. Only "resume" lifts this one. */
  paused: z.boolean().default(false),
  /** "Stop the morning messages" — the digest alone, instant alerts untouched. */
  digestPaused: z.boolean().default(false),
  /** "Only tell me about urgent things": tests, deadlines and venue changes. */
  alertLevel: z.enum(['all', 'urgent']).default('all'),
  /** Courses they still want in the digest but no longer want pinged about. */
  mutedCourseKeys: z.array(z.string()).default([]),
})
export type User = z.infer<typeof UserSchema>
