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
 * One message in the thread, either direction.
 *
 * Kept verbatim rather than summarised: "what did you say about the venue?" is about
 * the words Peermate actually sent, and a summary of a summary answers a different
 * question every time it is rewritten.
 */
export const TurnSchema = z.object({
  role: z.enum(['student', 'peermate']),
  text: z.string(),
  at: z.date(),
})
export type Turn = z.infer<typeof TurnSchema>

/**
 * Something found on the web and offered, not sent.
 *
 * Held apart from `files`, which are things people actually shared in the group. The
 * two must never be listed as one set: a student choosing "send 2" is entitled to
 * know whether number two came from their lecturer or from a search engine.
 */
export const WebFindSchema = z.object({
  position: z.number(),
  title: z.string(),
  url: z.string(),
})
export type WebFind = z.infer<typeof WebFindSchema>

/**
 * An alert Peermate sent, and the event it was about.
 *
 * WhatsApp's Reply quotes a message by id, so this is the only way to tell which of
 * fifty alerts "where is this holding?" is attached to. The 45-minute context is no
 * help here: replying to an older message is precisely what the Reply button is for.
 */
export const SentAlertSchema = z.object({
  waMessageId: z.string(),
  eventId: z.string(),
})
export type SentAlert = z.infer<typeof SentAlertSchema>

export const QuizQuestionSchema = z.object({
  question: z.string(),
  answer: z.string(),
  /** "CVE575-notes.pdf, p.4" — where the answer came from, for checking. */
  source: z.string().nullable(),
})
export type QuizQuestion = z.infer<typeof QuizQuestionSchema>

/**
 * A revision set in progress.
 *
 * Held whole rather than regenerated per question: the same material asked twice
 * produces different questions, so a quiz built fresh each turn would be a different
 * quiz each turn and the score would mean nothing.
 */
export const QuizSchema = z.object({
  courseKey: z.string(),
  questions: z.array(QuizQuestionSchema),
  index: z.number(),
  right: z.number(),
})
export type Quiz = z.infer<typeof QuizSchema>

/**
 * What the last exchange was about.
 *
 * Without this every DM is a first message, and the follow-ups people actually send
 * — "where is it?", "who said that?", "send the second one", "what about STA?" —
 * have no referent. They are not lazy phrasing; they are how conversation works.
 *
 * The referent fields are deliberately small and short-lived — enough to resolve a
 * pronoun. `turns` is the long memory, and is governed by different rules.
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
   * The running thread, oldest first.
   *
   * Separate from the fields above and outliving them on purpose. Those are
   * referents — "it", "that one" — and a stale referent answers about the wrong
   * thing, so they expire. A transcript cannot be wrong in that way: it is only ever
   * a record of what was said, and "what did I ask you yesterday?" needs it intact.
   */
  turns: z.array(TurnSchema).default([]),
  /** The revision set being worked through, question by question. */
  quiz: QuizSchema.nullable().default(null),
  /** Recent alerts, so a quoted reply can be matched to the event it is about. */
  alerts: z.array(SentAlertSchema).default([]),
  /** What a web search turned up, and what they asked for when it ran. */
  findings: z.array(WebFindSchema).default([]),
  wanted: z.string().nullable().default(null),
  /**
   * A command still waiting on one word back: a confirmation before anything is
   * destroyed, or the name they were asked for. Kept here rather than on the user so
   * an abandoned half-command expires with the rest of the context instead of
   * capturing an unrelated message an hour later.
   */
  pendingAction: z
    .enum([
      'confirm_wipe',
      'awaiting_name',
      'awaiting_resource_course',
      'confirm_group_course',
      'confirm_timetable',
      'confirm_send_files',
      'answering_quiz',
      'confirm_web_search',
      'choose_web_file',
    ])
    .nullable()
    .default(null),
  /**
   * The group-and-course pairing waiting on a yes.
   *
   * Held apart from `courseKey`, which means "the course we were last discussing".
   * Overloading that would make an unrelated question about another course silently
   * change which course a group gets filed under.
   */
  proposal: z
    .object({ chatJid: z.string(), groupName: z.string().nullable(), course: z.string() })
    .nullable()
    .default(null),
  /**
   * A timetable read out of a photograph, held until the student says it is right.
   * Stored whole rather than by id: nothing is written to `schedules` until they
   * confirm, so there is no row to point at yet.
   */
  timetable: z.unknown().nullable().default(null),
  updatedAt: z.date(),
})
export type Conversation = z.infer<typeof ConversationSchema>
