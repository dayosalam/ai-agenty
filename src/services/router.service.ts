import { zodResponseFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { getOpenAI } from './openai.client.js'

export const Intent = z.enum([
  'ask_question',
  'request_resources',
  'send_original',
  'repeat',
  'course_info',
  'my_timetable',
  'prep_test',
  'update_timetable',
  'catch_up',
  'list_courses',
  'add_course',
  'remove_course',
  'change_settings',
  'pause_alerts',
  'resume_alerts',
  'change_name',
  'group_link',
  'help',
  'unsupported',
  'smalltalk',
])
export type Intent = z.infer<typeof Intent>

const RoutedSchema = z.object({
  intent: Intent,
  /** The course this is about, resolved from the words or from context. */
  courseCode: z.string().nullable(),
  /** True when the course came from context rather than from what they typed. */
  courseFromContext: z.boolean(),
  /** How far back a catch-up should reach. Null for every other intent. */
  sinceDays: z.number().nullable(),
  /** How the student described that window, for the reply to echo back. */
  periodLabel: z.string().nullable(),
  /** "send the second one" -> [2]; "send all" -> []; with sendAll set. */
  filePositions: z.array(z.number()),
  sendAll: z.boolean(),
  /** "slides", "past questions" — narrows a shelf that would otherwise flood. */
  docType: z.enum(['slides', 'past_questions', 'assignment', 'textbook', 'any']),
  /** True when they are asking for material from beyond their own group. */
  outsideGroup: z.boolean(),
  /** What they want to be called, when they are asking to be called something else. */
  newName: z.string().nullable(),
  /** How far ahead "my_timetable" is asking. Null for every other intent. */
  horizon: z
    .enum([
      'today',
      'tomorrow',
      'week',
      'next',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
      'sunday',
    ])
    .nullable(),
  /** What to change on their stored timetable. Null for every other intent. */
  correction: z
    .object({
      kind: z.enum(['exam', 'test', 'lecture', 'tutorial', 'practical', 'any']),
      /** 24-hour "10:00". Null when the time is not what changed. */
      time: z.string().nullable(),
      venue: z.string().nullable(),
      /** "Monday" etc, when a weekly class moved day. */
      weekday: z.string().nullable(),
      /** YYYY-MM-DD, when a dated item moved. Pick from the calendar offered. */
      date: z.string().nullable(),
      /** True when they are asking to delete it rather than change it. */
      remove: z.boolean(),
    })
    .nullable(),
  /** A follow-up leaning on the previous answer rather than starting fresh. */
  isFollowUp: z.boolean(),
  /**
   * A second, different request in the same message. Only one intent can be acted
   * on, so this is what the reply admits it is not doing.
   */
  secondRequest: z.string().nullable(),
  confidence: z.number(),
})
export type Routed = z.infer<typeof RoutedSchema>

const SYSTEM = `You route WhatsApp messages a Nigerian university student sends to Peermate, a bot that listens to their course group chats.

Pick ONE intent:
- "ask_question" — asking about something that was announced. "when is the CSC 301 test?", "where is it holding?", "what did the lecturer say in the voice note?"
- "request_resources" — asking for the actual files, whether from their group or from outside it. "CSC 301 resources", "send me the past questions", "abeg share the slides", "can you send me some external material", "find me something online about it"
- "send_original" — asking for the source of something Peermate told them, not a course file. "send me the original voice note", "forward the actual message", "let me hear it myself", "send the photo he posted"
- "my_timetable" — asking about their OWN schedule: what they have on, and when. "what do I have today?", "any lecture tomorrow?", "when is my next exam?", "what's my week like?", "do I have class on Tuesday?". Set horizon to today, tomorrow, next, a named weekday, or week
- "update_timetable" — correcting their OWN stored timetable in words rather than re-sending a photo. "my CVE 575 lecture is at 10 not 8", "the ABE 501 exam moved to Friday", "CVE 565 is in LT2 now", "drop the Tuesday tutorial". Fill correction with what to change
- "prep_test" — asking to be prepared, revised or quizzed on a course from the material people shared. "prep me for the CVE 575 test", "help me study for ABE 501", "quiz me", "ask me questions", "give me practice questions", "what should I read for the test?"
- "course_info" — asking about a course itself rather than about one event in it. "tell me about CVE 575", "what is structural analysis", "who teaches ABE 501", "what have I got for CSC 301"
- "repeat" — asking for the last answer again, unchanged. "repeat that", "say that again", "come again", "what did you say?"
- "catch_up" — asking what has been happening generally, over a period. "what did I miss this week?", "give me a rundown", "anything happening in my groups?", "catch me up"
- "list_courses" — "what courses am I watching?", "my courses"
- "add_course" — "add MTH 101", "I'm also taking STA 202 now"
- "remove_course" — "remove STA 202", "I dropped CSC 301"
- "change_settings" — about the digest itself: its time, or text versus voice note. "send my digest at 6", "I want voice notes"
- "pause_alerts" — asking to be messaged less or not at all: "stop messaging me", "can you keep quiet until Monday", "I don't want the morning ones", "only tell me the important things", "no notifications this weekend", "abeg no dey disturb me"
- "resume_alerts" — asking to be messaged again: "you can start again", "turn the morning messages back on", "I want everything again"
- "change_name" — asking to be called something else. Put the name in newName, nothing else. "call me Ada", "stop calling me Adedamola"
- "group_link" — telling Peermate about a group: that they added it to one, or which course a group belongs to. "I added you to a group named peermate", "that group is for CVE 575", "the biology group is BIO 101"
- "help" — asking about Peermate itself rather than about a course: what it can do, or how to make it do something. "what can you do?", "help", "how do I approve the group?", "how do I add a course?", "how do I stop the morning messages?", "what does approve mean?", "how does this work?". Note the difference from ask_question: "how do I approve the group?" is about operating Peermate; "how do I get to LG7?" is about the world and Peermate cannot answer it
- "unsupported" — asking for something Peermate cannot do: setting a reminder for a specific time, texting someone else, opinions ("do you think the test will be hard?"), or general knowledge unrelated to their groups. NOT for questions about Peermate's own setup — "what group have you been approved for?", "which groups are you reading?", "are you connected yet?" are "help", because Peermate is the only thing that knows the answer
- "smalltalk" — greetings, thanks, acknowledgements ("ok", "it is done", 👍), anything with no request in it

The difference between ask_question and catch_up: a question is about ONE thing the student already has in mind. A catch-up is an open request for everything over a period.

The difference between ask_question and request_resources: a question wants an answer in words. A resource request wants the file sent. Merely mentioning a file — "what did he say in the voice note?" — is a question, not a request for files.

For "catch_up", set sinceDays from the period they named: today = 1, yesterday = 2, "this week"/"past week" = 7, "since Monday" = days since the most recent Monday, "this month" = 30. If they name no period, use 7. Also set periodLabel to a natural phrase that fits after "Here's what happened" — "this week", "today", "since Monday". For every other intent both are null.

COURSE. Set courseCode to the course this is about — "CSC 301" style, however they wrote it (CSC301, csc-301, "data structures" if the context names it). If they did not name one but the context above says which course they were just discussing, use that and set courseFromContext true. If neither, null.

OUTSIDE. Set outsideGroup true only when they ask for material from beyond their group — "external material", "anything online", "find something on the internet", "materials from outside", "textbooks I can read", "search for it". A plain "send me the CSC 301 slides" is false: that is a request for what their own group shared.

FILES. When they are picking from a list just shown: "send the second one" -> filePositions [2]; "send 1 and 3" -> [1,3]; "send all"/"everything" -> sendAll true. Otherwise empty and false. Set docType when they narrow the kind — "slides", "past questions only", "the assignment brief" — else "any".

CORRECTION. Set correction only for "update_timetable", and only for the fields that actually changed — everything else null. courseCode must name the course being corrected.

TIMETABLE. horizon is set only for "my_timetable": "today" for today, "tomorrow" for tomorrow, "next" when they ask what is coming up next or when their next exam is, the weekday itself when they name one ("on Tuesday" -> "tuesday"), and "week" for anything broader. Null everywhere else.

NAME. newName is set only for "change_name", and only to the name itself — "Ada", not "call me Ada". Null everywhere else.

FOLLOW-UP. Set isFollowUp true when the message only makes sense against the previous exchange: "where is it?", "what time?", "who said that?", "are you sure?", "what about STA?", "repeat that", "and the assignment?".

TWO REQUESTS. A message can carry more than one — "when is the test and send the slides". Route the FIRST one as the intent, and put the second in secondRequest as a short phrase naming it ("send the slides"). Null when there is only one request. Splitting a course list is not two requests: "add CSC 301 and remove STA 202" is one course-management instruction.

confidence is 0..1. Use below 0.5 when the message is genuinely ambiguous — it is better to ask than to guess wrong. A follow-up whose referent is missing from the context above is ambiguous, not confident.

Students write in English, Nigerian Pidgin, or a mix. Read for meaning, not grammar.`

/**
 * Works out what a DM is asking for.
 *
 * Regex got this wrong in a way that mattered: "what did the lecturer say in the
 * voice note?" matched on the word "note" and dumped the entire file library instead
 * of answering. Intent is a judgement about meaning, and a model makes it far better
 * than a pattern — and it is the only thing that handles Pidgin.
 *
 * Literal commands never reach here; DmService matches those first, so an operator
 * typing "status" is never subject to interpretation.
 */
export class RouterService {
  async route(text: string, context?: string | null, history?: string | null): Promise<Routed> {
    try {
      // The thread reaches further back than `context`, which expires with the
      // referents it holds. "You said Thursday" is about something said days ago, and
      // routed without it the question reads as an assertion about nothing.
      const system = [
        SYSTEM,
        history
          ? `\nTHE CHAT SO FAR (oldest first; their newest message is below it):\n${history}`
          : '',
        context ? `\nWhat they were just discussing — ${context}` : '',
      ]
        .filter(Boolean)
        .join('\n')

      const completion = await getOpenAI().beta.chat.completions.parse({
        model: config.openai.routingModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text },
        ],
        response_format: zodResponseFormat(RoutedSchema, 'route'),
      })

      const parsed = completion.choices[0]?.message.parsed
      if (!parsed) throw new Error('router returned nothing')
      logger.debug({ text: text.slice(0, 60), ...parsed }, 'routed')
      return parsed
    } catch (error) {
      // Answering the question is the safe default: it reads the archive and cites
      // sources. Guessing "resources" would send files nobody asked for.
      logger.error({ err: error }, 'routing failed, treating as a question')
      return {
        intent: 'ask_question',
        courseCode: null,
        courseFromContext: false,
        sinceDays: null,
        periodLabel: null,
        filePositions: [],
        sendAll: false,
        docType: 'any',
        outsideGroup: false,
        newName: null,
        horizon: null,
        correction: null,
        isFollowUp: false,
        secondRequest: null,
        confidence: 0,
      }
    }
  }
}

export const routerService = new RouterService()
