import { explain } from '../core/failures.js'
import { logger } from '../core/logger.js'
import type { Conversation, Group, Message, Quiz, User, WebFind } from '../models/index.js'
import {
  extractionRepository,
  groupRepository,
  messageRepository,
  userRepository,
} from '../repositories/index.js'
import { config } from '../config.js'
import { getMedia } from '../db/minio.js'
import { courseDisplay, courseKey, parseCourseList } from '../utils/courses.js'
import { formatStamp } from '../utils/dates.js'
import { jidToIdentity } from '../whatsapp/jid.js'
import { adminService } from './admin.service.js'
import { clarifyService } from './clarify.service.js'
import { conversationService } from './conversation.service.js'
import { PDF_MIME } from './document-reader.service.js'
import { DeliveryService } from './delivery.service.js'
import { digestService } from './digest.service.js'
import { courseService } from './course.service.js'
import { groupService } from './group.service.js'
import { guidanceService } from './guidance.service.js'
import { notifierService } from './notifier.service.js'
import { onboardingService } from './onboarding.service.js'
import { qaService } from './qa.service.js'
import { reminderService } from './reminder.service.js'
import { prepService } from './prep.service.js'
import { researchService } from './research.service.js'
import { resourceService } from './resource.service.js'
import { routerService, type Routed } from './router.service.js'
import { scheduleService } from './schedule.service.js'
import { timetableService, type ReadTimetable } from './timetable.service.js'
import { studentCommandsService } from './student-commands.service.js'
import { studentContextService } from './student-context.service.js'

/** "Quiz me", as opposed to "what should I revise?" — one asks, the other explains. */
const ASKS_TO_BE_QUIZZED = /\b(quiz|ask me|test me|start|practice questions|go ahead)\b/i

/**
 * A yes with nothing attached to it.
 *
 * Excludes "ok" and "okay", which are acknowledgements: replying to those is what
 * makes a bot exhausting to talk to. A "yes" is different — they expected something
 * to happen, and silence looks like it did.
 */
const STRAY_YES = /^(yes|yeah|yep|yup|sure|go ahead|send (it|them)|do it|please do)\b[\s.!]*$/i

/**
 * Picking from a list of web finds: "2", "send 1 and 3", "all".
 *
 * Deliberately strict. The list stays pickable for as long as the context lives, and a
 * loose pattern would swallow "when is the CVE 575 test?" as a request for file 575.
 */
const PICKS_FOUND = /^(send\s+)?(all|both|everything|\d+(\s*(,|and|&)?\s*\d+)*)\s*$/i

/** Mid-quiz, these are not answers. */
const ENDS_QUIZ = /^(stop|end|quit|cancel|enough|abeg stop|i'?m done|done)\b/i

/** Below this the model is guessing, and asking beats acting on a guess. */
const MIN_CONFIDENCE = 0.5

/** Intents where a bare "the lecture" is worth a question rather than a guess. */
const ASKABLE = new Set(['ask_question', 'my_timetable', 'course_info', 'request_resources'])

const NOT_AN_OPERATOR = `That's a setup command — only whoever runs Peermate can use it.

If a group needs connecting, tell me which course it's for and I'll pass it on. Send *help* for what you can do.`

const AGREED =
  /^(yes|yeah|yep|yh|correct|right|exactly|that'?s (it|right)|sure|ok(ay)?|na so|👍)\b/i
const DECLINED = /^(no|nope|nah|wrong|not (that|it)|different|another)\b/i

/** One pictograph or several, with nothing else in the message. */
const EMOJI_ONLY = /^(?:[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]|\s)+$/u
const PUZZLED = /[\u{2753}\u{2754}\u{1F914}\u{1F615}\u{1F644}\u{1F928}]/u

/**
 * Says which part could not be trusted, rather than "I couldn't read that".
 *
 * A student who photographed a real, sharp timetable and is told it was unreadable
 * will just send it again. The useful thing is that the *dates* did not land — which
 * they can act on, usually by noticing it is last session's sheet.
 */
function staleTimetable(read: ReadTimetable): string {
  const [clash] = read.mismatches
  const courses = [...new Set(read.undated.filter(Boolean))].slice(0, 3).join(', ')

  const evidence = clash
    ? `it has *${clash.written}* against a date that falls on a *${clash.resolved.split(' ')[0]}*`
    : `I couldn't place ${courses ? `the dates for *${courses}*` : 'any of the dates'} on this year's calendar`

  return `I read that, but ${evidence}.

That usually means it's from a previous session. I haven't saved anything — reminders off a stale timetable are worse than none.

If it is current, tell me the year and I'll take another look.`
}

/**
 * The one course a message consists of, or null.
 *
 * "CVE 575" and nothing else is a request about that course. "when is the CVE 575
 * test?" is not — it names a course but asks something specific about it.
 */
/**
 * What they actually want, with the asking stripped out.
 *
 * "Can you get me more external material for CVE 575 transportation engineering"
 * becomes "transportation engineering". The course code goes too: it is the one term
 * guaranteed to match the wrong university's course of the same number.
 */
function subjectWords(text: string): string {
  return text
    .replace(/\b[A-Za-z]{2,4}\s?\d{3,4}\b/g, ' ')
    .replace(ASKING, ' ')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The pickable list, identical whether it is new or being shown again. */
function listFindings(findings: WebFind[]): string {
  const lines = findings.map((item) => `${item.position}. *${item.title}*\n   ${item.url}`)
  return `${lines.join('\n\n')}

_From the web, not from your group._

Send *1*, *send 1 and 3*, or *all* and I'll send them over.`
}

/**
 * A course title, only when it is written where a title goes: straight after the code.
 *
 * "CVE 575 transportation engineering" names the subject. "How many PDFs do we have on
 * CVE 565" does not — and taking the leftovers of that sentence filed the course under
 * the title "How many", which then became the query every later search ran on.
 */
function titleAfterCode(text: string, key: string): string {
  const pattern = /([A-Za-z]{2,4})\s?(\d{3,4})\s*[:,-]?\s*([A-Za-z][A-Za-z\s]{3,60})/g

  for (const match of text.matchAll(pattern)) {
    if (courseKey(`${match[1]}${match[2]}`) !== key) continue
    const words = subjectWords(match[3] ?? '')
      .split(/\s+/)
      .filter((word) => /^[a-z]{4,}$/i.test(word))
    if (words.length >= 2) return words.join(' ')
  }
  return ''
}

/** The words of the request rather than of the subject. */
const ASKING =
  /\b(can|could|would|will|you|u|please|abeg|pls|plz|get|send|share|find|look|search|give|me|my|more|some|any|another|other|one|extra|external|outside|online|internet|web|material|materials|resource|resources|note|notes|file|files|document|documents|pdf|pdfs|book|for|about|on|of|the|a|an|i|we|want|need|it|them|too|also|again|thanks|thank|how|what|which|when|where|who|why|many|much|do|does|did|have|has|had|is|are|there|past|question|questions|paper|papers|slide|slides|lecture|lectures|tutorial|exam|exams|test|tests|assignment|assignments|textbook)\b/gi

function soleCourse(text: string, user: User): string | null {
  const [named, ...rest] = parseCourseList(text)
  if (!named || rest.length > 0) return null
  if (!user.courseKeys.includes(named)) return null

  const leftover = text.replace(/[^a-z0-9]+/gi, '')
  return leftover.toUpperCase() === named ? named : null
}

function reactionTo(text: string): 'puzzled' | 'acknowledgement' | 'not-emoji' {
  if (!EMOJI_ONLY.test(text) || !/\p{Extended_Pictographic}/u.test(text)) return 'not-emoji'
  return PUZZLED.test(text) ? 'puzzled' : 'acknowledgement'
}

/**
 * One in-flight message per student.
 *
 * People send three messages in five seconds — "CSC 301", "resources", "past
 * questions" — and handled concurrently they answer out of order, or worse, each
 * overwrites the conversation context the next one depends on. Serialising per
 * student costs nothing and makes the thread read like a conversation.
 */
const inFlight = new Map<string, Promise<void>>()

/**
 * Everything a student sends in a 1:1 DM lands here.
 *
 * Order matters. Literal commands win, so an operator typing "status" is never
 * subject to interpretation. Onboarding comes next: an unregistered sender has no
 * courses, so there is nothing to retrieve against. Only what is left — real,
 * free-form language — goes to the model.
 */
export class DmService {
  async handle(message: Message): Promise<void> {
    const phone = jidToIdentity(message.chatJid)
    if (!phone) return

    const previous = inFlight.get(phone) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => this.process(phone, message))
      .finally(() => {
        if (inFlight.get(phone) === next) inFlight.delete(phone)
      })

    inFlight.set(phone, next)
    return next
  }

  private async process(phone: string, message: Message): Promise<void> {
    // A photographed timetable or a recorded question carries its content in the
    // transcript, not in the caption — often there is no caption at all.
    const text = [message.text, message.caption, message.transcript]
      .filter(Boolean)
      .join('\n')
      .trim()

    if (text && adminService.isOperator(phone)) {
      const reply = await adminService.handle(text)
      if (reply) {
        await notifierService.sendText(message.chatJid, reply)
        return
      }
    }

    const onboardingReply = await onboardingService.handle(message)
    if (onboardingReply) {
      await notifierService.sendText(message.chatJid, onboardingReply)
      return
    }

    const stored = await userRepository.findByPhone(phone)
    if (!stored || stored.onboardingState !== 'registered') return

    // Checked here rather than swept on a timer, so a pause that ran out while the
    // process was down is still over when it comes back up.
    const user = DeliveryService.expired(stored) ? await this.liftPause(stored) : stored
    await conversationService.touch(phone)

    if (!text) {
      await this.say(
        phone,
        message.chatJid,
        message.type === 'image' || message.type === 'audio'
          ? "I couldn't make anything out of that. Could you send it again, or type it out?"
          : 'Ask me something like *"when is the CSC 301 test?"*',
      )
      return
    }

    await conversationService.rememberTurn(phone, 'student', text)

    // A quoted reply points at one specific alert, which is the whole reason somebody
    // uses Reply instead of just typing. The 45-minute context cannot do this: they
    // are replying to an older message precisely because it is not the current one.
    const quoted = message.quotedMessageId
      ? await this.focusQuoted(user, message.quotedMessageId)
      : false

    // An answer to a question Peermate asked, before anything reinterprets it.
    if (await this.answerPending(user, text, message.chatJid)) return

    // A photographed timetable is not a question. Routed as one it becomes a search
    // for whatever the OCR happened to say, which is never what they meant.
    if (timetableService.looksLikeTimetable(message)) {
      if (await this.readTimetable(user, message)) return
    }

    // A demo hook. Nothing is said back: the reminder arriving on its own is the
    // whole point, and an acknowledgement would both precede it and give the delay
    // away. Only a failure to schedule one is worth a reply.
    if (text.trim() === 'REMINDER_TEST') {
      const problem = await reminderService.previewIn(user, 10_000)
      if (problem) await this.say(phone, message.chatJid, problem)
      return
    }

    // Exact commands first: zero latency, zero cost, and no chance of a model
    // reinterpreting a word the student meant literally.
    const command = await studentCommandsService.handle(user, text)
    if (command) {
      await this.say(phone, message.chatJid, command)
      return
    }

    // Nothing was pending — answerPending already had its chance. A yes with nothing
    // to agree to usually means Peermate asked something and the context expired.
    if (STRAY_YES.test(text.trim())) {
      await this.say(
        phone,
        message.chatJid,
        "Yes to what? I'm not waiting on an answer to anything right now — if I asked you something a while back, it's expired. Ask me again and I'll pick it up.",
      )
      return
    }

    // A course code on its own. The router reads this as a question about the course
    // often enough, but "often enough" means a code typed into a quiet chat sometimes
    // gets searched for instead of answered, which looks like nothing happened.
    const alone = soleCourse(text, user)
    if (alone) {
      await conversationService.rememberCourse(phone, alone)
      await this.say(phone, message.chatJid, await courseService.rundown(user, alone))
      return
    }

    if (adminService.looksLikeOperatorCommand(text)) {
      await this.say(phone, message.chatJid, NOT_AN_OPERATOR)
      return
    }

    // "How do I approve it?" is a question about Peermate, not about a course.
    // Routed as a question it searches the group archive, finds nothing, and says so
    // — which reads as broken to somebody who was asking for instructions.
    if (guidanceService.looksLikeAboutPeermate(text)) {
      const how = await guidanceService.answer(user, text, adminService.isOperator(phone))
      await this.say(phone, message.chatJid, how)
      await conversationService.rememberQuestion(phone, text, how)
      return
    }

    const emoji = reactionTo(text)
    if (emoji !== 'not-emoji') {
      // A thumbs-up is an acknowledgement, and replying to one is what makes a bot
      // exhausting to talk to. Only a puzzled face is actually asking something.
      if (emoji === 'puzzled') {
        await this.say(
          phone,
          message.chatJid,
          'Not sure what you need — ask me something like *"when is the CSC 301 test?"*, or send *help*.',
        )
      }
      return
    }

    try {
      // Typing stays visible for the whole call, not just the first ten seconds.
      const reply = await notifierService.withTyping(message.chatJid, () =>
        this.respond(user, text, message.chatJid, message.type === 'audio', quoted),
      )
      if (reply) {
        await this.say(phone, message.chatJid, reply)
        await conversationService.rememberQuestion(phone, text, reply)
      }
    } catch (error) {
      // Say what actually failed. "Something went wrong" makes an outage
      // indistinguishable from a question that simply has no answer.
      logger.error({ err: error, phone }, 'dm handling failed')
      await this.say(phone, message.chatJid, explain(error))
    }
  }

  /**
   * Sends a reply and keeps it in the thread.
   *
   * Every reply, not only the ones a model wrote. "What did you tell me about the
   * venue?" means whatever Peermate actually sent, which is as often a file listing
   * or a command reply as it is an answer.
   */
  private async say(phone: string, jid: string, body: string): Promise<void> {
    await notifierService.sendText(jid, body)
    await conversationService.rememberTurn(phone, 'peermate', body)
  }

  /** Returns the text to send, or null when the branch already replied itself. */
  private async respond(
    user: User,
    text: string,
    jid: string,
    spoken: boolean,
    quoted = false,
  ): Promise<string | null> {
    const context = await conversationService.summarise(user.phone)
    // Short for the router, which only has to recognise what is being referred to.
    const history = await conversationService.transcript(user.phone, 10, 200)
    const routed = await routerService.route(text, context, history)

    const resolved = await this.resolveCourse(user, routed, text)
    if (resolved.ask) return resolved.ask
    if (resolved.courseKey) await conversationService.rememberCourse(user.phone, resolved.courseKey)

    if (routed.confidence < MIN_CONFIDENCE) {
      return routed.isFollowUp
        ? `${this.heard(text, spoken)}I'm not sure what that's about — we haven't talked about anything recently. Which course, and what would you like to know?`
        : `${this.heard(text, spoken)}I'm not sure what you're after. Do you want:\n\n• an answer about something that was announced\n• the files for a course\n• a rundown of what's been happening\n\nJust say which, or send *help*.`
    }

    // "When is the lecture?" from somebody taking eight courses. Asking beats
    // picking: a confident answer about the wrong lecture cannot be told from a
    // right one, and the student has no reason to doubt it.
    if (ASKABLE.has(routed.intent)) {
      const question = await clarifyService.ask(user, text, resolved.courseKey)
      if (question) return question
    }

    const reply = await this.act(user, text, jid, routed, resolved.courseKey, quoted)

    // Two requests in one message. Answering only the first and saying so is honest
    // but still leaves them to ask again, so the second one is routed and acted on in
    // its own right — and only falls back to admitting it when that does not work.
    if (reply && routed.secondRequest) {
      const also = await this.alsoAnswer(user, routed.secondRequest, jid)
      if (!also.handled) {
        return `${reply}\n\n_You also asked me to ${routed.secondRequest.replace(/^(to|please)\s+/i, '')} — ask me that on its own and I'll do it._`
      }
      // Null text means that branch sent its own reply — files, a shelf, a quiz
      // question. Appending anything would be talking over it.
      return also.text ? `${reply}\n\n———\n\n${also.text}` : reply
    }
    return reply
  }

  /**
   * The second half of a two-part message, handled as its own request.
   *
   * One round only: whatever this routes to cannot spawn a third. `handled` is false
   * when it is not confident or the course is ambiguous — admitting the second half
   * went unanswered beats guessing at it. `text` is null when that branch already
   * replied for itself, which is a different thing.
   */
  private async alsoAnswer(
    user: User,
    request: string,
    jid: string,
  ): Promise<{ handled: boolean; text: string | null }> {
    try {
      const routed = await routerService.route(
        request,
        await conversationService.summarise(user.phone),
      )
      if (routed.confidence < MIN_CONFIDENCE) return { handled: false, text: null }

      const resolved = await this.resolveCourse(user, routed, request)
      if (resolved.ask) return { handled: false, text: null }

      const text = await this.act(
        user,
        request,
        jid,
        { ...routed, secondRequest: null },
        resolved.courseKey,
      )
      return { handled: true, text }
    } catch (error) {
      logger.warn({ err: error }, 'could not answer the second request')
      return { handled: false, text: null }
    }
  }

  private async act(
    user: User,
    text: string,
    jid: string,
    routed: Routed,
    scoped: string | null,
    quoted = false,
  ): Promise<string | null> {
    switch (routed.intent) {
      case 'catch_up':
        return digestService.catchUp(user, routed.sinceDays ?? 7, routed.periodLabel ?? 'this week')

      case 'repeat': {
        // Deterministic on purpose: re-running retrieval for "say that again" can
        // produce a different answer, which is the one thing repeating must not do.
        const said = await conversationService.lastAnswer(user.phone)
        return said ?? "I haven't told you anything yet — ask me something first."
      }

      case 'send_original':
        return this.sendOriginal(user, jid)

      case 'my_timetable': {
        // Only a course they actually named narrows this. "When is my next class?" is
        // about all of them, and a course carried over from the last exchange turns it
        // into an answer about one — which reads as Peermate having forgotten the rest
        // of their timetable.
        const named = (await courseService.resolve(text, user))?.courseKey ?? null
        const answer = await scheduleService.answer(user, routed.horizon ?? 'week', named)
        // Null means they have never sent one — an empty week would read as "nothing
        // is on", when the truth is Peermate has never been shown their timetable.
        return (
          answer ??
          `I don't have your timetable yet. Send me a photo of it — exam or class — and I'll keep track and remind you before each one.`
        )
      }

      case 'update_timetable': {
        if (!routed.correction) return this.whichCourse(user)
        const key = scoped ?? (await courseService.resolve(text, user))?.courseKey
        if (!key) return this.whichCourse(user)
        return scheduleService.amend(user, key, routed.correction)
      }

      case 'course_info': {
        const key = scoped ?? (await courseService.resolve(text, user))?.courseKey
        if (!key) return this.whichCourse(user)
        await conversationService.rememberCourse(user.phone, key)
        return courseService.rundown(user, key)
      }

      case 'request_resources':
        return this.resources(user, text, jid, routed, scoped)

      case 'unsupported':
        return this.unsupported(user)

      case 'group_link':
        return this.linkGroup(user, text)

      case 'help':
        return guidanceService.answer(user, text, adminService.isOperator(user.phone))

      case 'list_courses':
      case 'add_course':
      case 'remove_course':
      case 'change_settings':
      case 'pause_alerts':
      case 'resume_alerts':
      case 'change_name':
        // The model recognised an instruction the literal matcher missed, usually
        // because it was phrased as a sentence. Hand it back with an explicit verb.
        // A miss falls through to guidance, never to retrieval: every one of these is
        // about Peermate, and the group archive has nothing to say about any of them.
        return (
          (await studentCommandsService.handle(user, this.asCommand(routed, text))) ??
          guidanceService.answer(user, text, adminService.isOperator(user.phone))
        )

      case 'prep_test':
        return this.prep(user, text, scoped, jid)

      case 'smalltalk':
        return this.smalltalk(user)

      default: {
        // A question about one course searches only that course, so "what about
        // STA?" after a CSC answer does not drag the CSC messages back in.
        const scope = scoped ? [scoped] : user.courseKeys
        // "Where is it?" is about the alert they were just sent, not about every
        // venue ever mentioned in the course.
        // A quoted reply is a follow-up whatever the router made of the words: the
        // student pointed at the message. Without this, "is it still holding?" quoted
        // onto an alert is answered against the whole course.
        const focus =
          routed.isFollowUp || quoted ? await conversationService.focus(user.phone) : null
        // Who they are travels with every question. "When is my lecture?" has no
        // answer in any group message — it is in their own record — and without this
        // the model refuses a question it could have answered.
        const profile = await studentContextService.describe(user)
        // Longer here than for the router: answering "you told me it moved — what was
        // the old date?" means reading the earlier reply, not just recognising it.
        return qaService.answer(
          text,
          scope,
          focus,
          profile,
          await conversationService.transcript(user.phone, 20, 400),
        )
      }
    }
  }

  /**
   * Which course the student means.
   *
   * Resolved in the order a person would: what they said, then what we were just
   * discussing, then — only when they take exactly one course — the obvious one.
   * Anything else is a real ambiguity, and a guess produces a confident answer
   * about the wrong subject.
   */
  private async resolveCourse(
    user: User,
    routed: Routed,
    text: string,
  ): Promise<{ courseKey: string | null; ask: string | null }> {
    const named = courseKey(routed.courseCode)

    /**
     * A course code has to come from somewhere real.
     *
     * The router's own prompt is dense with example codes, and asked to fill a
     * courseCode slot for "is there any material for the course?" it returned
     * CSC 301 — an example, not a reading of the message. Confirmed against the live
     * model, which has also returned "/" as a course code.
     *
     * So a code counts only when the student typed it, or when the router says it
     * took it from the conversation. Otherwise it is dropped and the ordinary
     * resolution below runs — which asks, rather than guessing. Checking only that
     * the code is one of theirs is not enough: an invented code that happens to be a
     * course they take would answer confidently about the wrong subject.
     */
    const grounded =
      named !== null && (parseCourseList(text).includes(named) || routed.courseFromContext)

    if (grounded && user.courseKeys.includes(named!)) return { courseKey: named, ask: null }

    if (grounded) {
      // They named something real but not theirs — a typo, or a course they dropped.
      const near = user.courseKeys.find((key) => key.slice(0, 3) === named!.slice(0, 3))
      return {
        courseKey: null,
        ask: near
          ? `You're not watching *${courseDisplay(named)}*. Did you mean *${courseDisplay(near)}*? Send *add ${courseDisplay(named)}* if you want it too.`
          : `You're not watching *${courseDisplay(named)}*. Send *add ${courseDisplay(named)}* and I'll start including it.`,
      }
    }

    // A title or a lecturer is as specific as a code — it just is not written as one.
    // Checked before context, so "what about structural analysis?" switches course
    // instead of being answered against whatever was last discussed.
    // The student's own words, never the router's courseCode — passing that back in
    // re-admits exactly the invented code the check above just rejected.
    const known = await courseService.resolve(text, user)
    if (known) return { courseKey: known.courseKey, ask: null }

    const needsCourse =
      routed.intent === 'ask_question' ||
      routed.intent === 'request_resources' ||
      routed.intent === 'course_info' ||
      routed.intent === 'update_timetable'
    // A timetable question is about all their courses unless they named one, and
    // falling back to "the course we were just discussing" would quietly narrow
    // "what do I have today?" to whichever one came up last.
    if (routed.intent === 'my_timetable') return { courseKey: null, ask: null }
    if (!needsCourse) return { courseKey: null, ask: null }

    // Only one course: there is nothing to be ambiguous about.
    if (user.courseKeys.length === 1) return { courseKey: user.courseKeys[0]!, ask: null }

    const remembered = (await conversationService.get(user.phone))?.courseKey
    if (remembered && user.courseKeys.includes(remembered)) {
      return { courseKey: remembered, ask: null }
    }

    // Leave it open: a broad question across every course is usually right, and
    // asking "which course?" for "what's due this week?" would be obtuse.
    return { courseKey: null, ask: null }
  }

  /**
   * A photograph of their own timetable or course list.
   *
   * Nothing is stored here. The student cannot see what the OCR made of their
   * handwriting, so the reading is shown back and only written once they agree —
   * a silently accepted misreading turns up weeks later as a reminder for the wrong
   * day, by which time the photograph is far up the chat and nobody suspects it.
   *
   * Returns false when the picture is not a timetable, so an ordinary photo with a
   * question in the caption still reaches the router.
   */
  private async readTimetable(user: User, message: Message): Promise<boolean> {
    const read = await notifierService.withTyping(message.chatJid, () =>
      timetableService.read(message),
    )
    if (!read || read.kind === 'other') return false

    if (read.unreadable) {
      await this.say(
        user.phone,
        message.chatJid,
        "I can see that's a timetable but I can't read it clearly enough to trust it. Could you send a sharper photo, or type the rows out?",
      )
      return true
    }

    // Titles and lecturers are worth keeping whatever they decide about the
    // schedule: they are what makes "Dr Bello's course" resolvable later.
    await courseService.learn(read.courses)

    // Every row's day contradicting its date means the picture is from another year,
    // not that one cell was misread. Storing it would schedule reminders for days the
    // student was never told — and they would only find out by missing an exam.
    // Nothing placeable and plenty attempted means the picture is from another
    // session — the offered calendar only looks forward, so last year's dates match
    // nothing. Storing the weekdays instead would remind them every Tuesday for ever.
    if (read.entries.length === 0 && (read.mismatches.length > 0 || read.undated.length > 0)) {
      await this.say(user.phone, message.chatJid, staleTimetable(read))
      return true
    }

    // Entries are the evidence, not the label. A week's grid is mostly course codes,
    // so "course list" is the easy misread — and taking it discarded a fully read
    // timetable, leaving the student enrolled in the right courses with no schedule
    // and no sign that anything had been lost.
    if (read.entries.length === 0) {
      const reply = await this.takeCourseList(user, read.courseKeys)
      await this.say(user.phone, message.chatJid, reply)
      return true
    }

    // Their own timetable is the most authoritative statement of what they take, and
    // apply() keeps only rows for courses they watch — so without this a first
    // timetable is read correctly, previewed in full, and then stores nothing.
    const added = await this.watchCoursesIn(user, read.entries)

    await conversationService.proposeTimetable(user.phone, read)
    const note = added.length
      ? `\n\n_I've added ${added.map(courseDisplay).join(', ')} to your courses — they were on it and you weren't watching them._`
      : ''
    await this.say(user.phone, message.chatJid, `${scheduleService.preview(read, user)}${note}`)
    return true
  }

  /** A photographed course list, which is a request to watch those courses. */
  /** Adds the courses a photographed timetable names but the student is not watching. */
  private async watchCoursesIn(user: User, entries: ReadTimetable['entries']): Promise<string[]> {
    const named = [
      ...new Set(
        entries.map((entry) => entry.courseKey).filter((key): key is string => Boolean(key)),
      ),
    ]
    const fresh = named.filter((key) => !user.courseKeys.includes(key))
    if (fresh.length === 0) return []

    user.courseKeys = [...user.courseKeys, ...fresh]
    await userRepository.upsert(user)
    logger.info({ phone: user.phone, fresh }, 'courses added from a timetable')
    return fresh
  }

  private async takeCourseList(user: User, courseKeys: string[]): Promise<string> {
    const fresh = courseKeys.filter((key) => !user.courseKeys.includes(key))
    if (courseKeys.length === 0) {
      return "I couldn't pick any course codes out of that. Send them as text — like *CVE 575, ABE 501* — and I'll take it from there."
    }
    if (fresh.length === 0) {
      return `I read ${courseKeys.map(courseDisplay).join(', ')} — you're already watching all of those.`
    }

    await userRepository.upsert({ ...user, courseKeys: [...user.courseKeys, ...fresh] })
    logger.info({ phone: user.phone, fresh }, 'courses added from a photograph')
    return `Read that as a course list. Added *${fresh.map(courseDisplay).join(', ')}*.

You're now watching ${[...user.courseKeys, ...fresh].map(courseDisplay).join(', ')}.

If I got a code wrong, send *remove <code>*.`
  }

  /**
   * The answer to something Peermate itself just asked.
   *
   * Deterministic by design. These follow an instruction Peermate gave a second
   * earlier, so leaving them to the router makes the step right most of the time —
   * which is not good enough when the question was "which course is this group for?"
   * and the answer decides where a semester of announcements gets filed.
   *
   * Returns true when the message was consumed. Anything that is not an answer falls
   * through to ordinary handling, so changing the subject is always allowed.
   */
  private async answerPending(user: User, text: string, jid: string): Promise<boolean> {
    const conversation = await conversationService.get(user.phone)

    if (conversation?.pendingAction === 'answering_quiz' && conversation.quiz) {
      await this.markQuizAnswer(user, conversation.quiz, text, jid)
      return true
    }

    if (conversation?.pendingAction === 'confirm_timetable' && conversation.timetable) {
      if (DECLINED.test(text)) {
        await conversationService.proposeTimetable(user.phone, null)
        await this.say(
          user.phone,
          jid,
          'Dropped it — nothing stored. Send a clearer photo when you can, or type the rows out.',
        )
        return true
      }
      if (!AGREED.test(text)) return false

      await conversationService.proposeTimetable(user.phone, null)
      const stored = await scheduleService.apply(user, conversation.timetable as ReadTimetable)
      await this.say(
        user.phone,
        jid,
        stored === 0
          ? "None of those were for courses you're watching, so I haven't stored anything. Add the course first with *add <code>*."
          : `Saved ${stored} item${stored === 1 ? '' : 's'} 👍\n\nI'll remind you before each one — a day ahead for exams, about an hour ahead for classes. Send *pause* any time if that's too much.`,
      )
      return true
    }

    if (conversation?.pendingAction === 'confirm_send_files' && conversation.files.length > 0) {
      if (DECLINED.test(text)) {
        await conversationService.expect(user.phone, null)
        await this.say(
          user.phone,
          jid,
          "Alright, I won't send them. They're there when you want them.",
        )
        return true
      }
      if (!AGREED.test(text)) return false

      await conversationService.expect(user.phone, null)
      const failure = await resourceService.sendRemembered(user, conversation.files)
      if (failure) await this.say(user.phone, jid, failure)
      return true
    }

    if (conversation?.pendingAction === 'confirm_group_course' && conversation.proposal) {
      const reply = await this.resolveGroupProposal(user, conversation.proposal, text)
      if (!reply) return false
      await this.say(user.phone, jid, reply)
      await conversationService.rememberQuestion(user.phone, text, reply)
      return true
    }

    if (conversation?.pendingAction === 'confirm_web_search') {
      if (DECLINED.test(text)) {
        await conversationService.expect(user.phone, null)
        await this.say(
          user.phone,
          jid,
          "Alright — I'll stick to what your group shares. Ask me again whenever you want me to look.",
        )
        return true
      }
      if (!AGREED.test(text)) return false

      await this.searchOutside(user, conversation.courseKey, conversation.wanted ?? '', jid, [])
      return true
    }

    if (conversation?.pendingAction === 'choose_web_file' && conversation.findings.length > 0) {
      if (DECLINED.test(text)) {
        await conversationService.expect(user.phone, null)
        await this.say(
          user.phone,
          jid,
          'No problem — the links are up there if you change your mind.',
        )
        return true
      }
      if (!PICKS_FOUND.test(text.trim())) return false

      const picked = [...text.matchAll(/\d+/g)].map((match) => Number(match[0]))
      await this.sendFound(user, conversation.findings, picked, jid)
      return true
    }

    if (conversation?.pendingAction !== 'awaiting_resource_course') return false

    await conversationService.expect(user.phone, null)

    const [named] = parseCourseList(text).filter((key) => user.courseKeys.includes(key))
    // Not a course: they changed the subject, and holding them to the menu would be
    // answering a question they are no longer asking.
    if (!named) return false

    await conversationService.rememberCourse(user.phone, named)
    await notifierService.withTyping(jid, async () => {
      const shelf = await resourceService.shelf(user, text, named)
      await this.say(user.phone, jid, shelf.summary)
      if (shelf.files.length > 0) {
        await conversationService.rememberFiles(user.phone, shelf.files)
        if (!shelf.tooMany) await resourceService.sendFiles(user, shelf.files)
      }
    })
    return true
  }

  /**
   * The actual voice note or photo behind something Peermate reported.
   *
   * "Are you sure?" and "let me hear it myself" are the same request: the student
   * wants to check the source rather than trust the summary. They are already in the
   * group it came from — this saves them scrolling for it, it does not show them
   * anything they could not already see.
   */
  private async sendOriginal(user: User, jid: string): Promise<string | null> {
    const remembered = await conversationService.get(user.phone)
    if (!remembered?.sourceMessageId) {
      return "I'm not sure which one you mean. Ask me about something first, then say *send the original*."
    }

    const source = await messageRepository.findById(remembered.sourceMessageId)
    if (!source) return "I can't find that message any more, sorry."

    const stamp = formatStamp(source.timestamp, config.digest.timezone)
    const who = source.senderName ?? 'someone'

    if (!source.mediaKey) {
      const words = source.text ?? source.caption
      return words
        ? `That one was typed, not recorded. Word for word:\n\n_"${words}"_\n\n— ${who}, ${stamp}`
        : `There's nothing to play — that one was a plain message.`
    }

    try {
      const bytes = await getMedia(source.mediaKey)
      if (source.type === 'audio') await notifierService.sendVoiceNote(jid, bytes)
      else if (source.type === 'image') await notifierService.sendImage(jid, bytes)
      else {
        await notifierService.sendFile(
          jid,
          source.mediaKey,
          source.fileName ?? 'attachment',
          source.mimeType ?? undefined,
        )
      }
    } catch (error) {
      logger.error({ err: error, mediaKey: source.mediaKey }, 'could not send original')
      return explain(error)
    }

    return `That's the original — ${who}, ${stamp}.`
  }

  /** Listing, narrowing, and picking out of a list already shown. */
  private async resources(
    user: User,
    text: string,
    jid: string,
    routed: Routed,
    scoped: string | null,
  ): Promise<string | null> {
    // "send the second one" / "send all" — picking from what was just listed.
    if (routed.filePositions.length > 0 || routed.sendAll) {
      const picked = await resourceService.pickFromLast(user, routed.filePositions, routed.sendAll)
      if (picked.error) return picked.error
      await this.say(user.phone, jid, picked.summary)
      return resourceService.sendRemembered(user, picked.files)
    }

    if (resourceService.needsCourse(user, text) && !scoped) return resourceService.courseMenu(user)

    // Asked for outright, so the group shelf is not what they want — but the offer is
    // still made rather than acted on: a search is Peermate reaching outside the one
    // place the student agreed it would listen to.
    if (routed.outsideGroup) {
      // "Can you get one more" is not a fresh decision — they already said yes, and
      // asking again turns a follow-up into a form to fill in twice.
      const already = await conversationService.get(user.phone)
      if (already?.findings.length) {
        const subject = subjectWords(text) || (already.wanted ?? '')
        await this.searchOutside(user, already.courseKey ?? scoped, subject, jid, already.findings)
        return null
      }
      return this.offerOutside(user, text, scoped, null)
    }

    const shelf = await resourceService.shelf(user, text, scoped, routed.docType)
    if (shelf.files.length === 0) {
      return this.offerOutside(user, text, scoped, shelf.summary)
    }

    await conversationService.rememberFiles(user.phone, shelf.files)

    // Offered, never pushed. Attachments cost the student money on metered data, and
    // a shelf that arrives unasked spends it on files they may already have.
    if (!shelf.tooMany) await conversationService.expect(user.phone, 'confirm_send_files')

    const ask = shelf.tooMany ? '' : `\n\nSend them? *yes*, or pick from the list like *send 2*.`
    await this.say(user.phone, jid, `${shelf.summary}${ask}`)
    return null
  }

  /**
   * Makes the quoted alert the thing being discussed.
   *
   * Nothing is said about it — the student's own words are still the question. This
   * only replaces the referent, so "where is this holding?" resolves against the
   * message they pointed at rather than the last one they happened to receive.
   */
  private async focusQuoted(user: User, quotedMessageId: string): Promise<boolean> {
    const eventId = await conversationService.alertFor(user.phone, quotedMessageId)
    if (!eventId) return false

    const extraction = await extractionRepository.findByEventId(eventId)
    if (!extraction) return false

    await conversationService.rememberEvent(user.phone, extraction)
    logger.debug({ phone: user.phone, eventId }, 'quoted an alert')
    return true
  }

  /**
   * Offers to look beyond the group, rather than doing it.
   *
   * Peermate was added to one group and told to listen there. Answering "have you got
   * the notes?" with something off the internet — unasked, unlabelled and not what
   * their lecturer set — is a different product from the one they agreed to.
   */
  private async offerOutside(
    user: User,
    text: string,
    scoped: string | null,
    preamble: string | null,
  ): Promise<string> {
    const course = scoped ? (courseDisplay(scoped) ?? scoped) : 'that'
    const before = preamble ? `${preamble}\n\n` : ''

    // Promising a search there is no key for would be the worst of both.
    if (!config.research.enabled) return preamble ?? `I don't have anything for *${course}*.`

    if (scoped) await conversationService.rememberCourse(user.phone, scoped)

    // Their own words, not the whole message: "can you get one more" carries no
    // subject, and a query built from it collapses back onto the course number.
    const words = subjectWords(text)
    if (scoped) await this.learnTitle(scoped, titleAfterCode(text, scoped))
    await conversationService.offerWebSearch(user.phone, words)

    return `${before}Want me to look outside your group? I can search the web for *${course}* material and send you what I find.

It won't be your lecturer's own notes, so treat it as extra reading rather than as what you'll be tested on.

Send *yes* and I'll look.`
  }

  /**
   * Takes the course's name from the student, when nobody has supplied one.
   *
   * "External material for CVE 575 transportation engineering" is the only place that
   * title has ever appeared — no timetable was photographed — and without it the next
   * search falls back to the number, which is what matched Math 575 in the first
   * place. A title already on record is never overwritten: it came from a document.
   */
  private async learnTitle(key: string, title: string): Promise<void> {
    if (!title) return
    if ((await courseService.find(key))?.title) return

    await courseService.learn([
      { courseKey: key, code: courseDisplay(key) ?? key, title, lecturer: null },
    ])
  }

  /** What the search turned up, offered as a list rather than sent unasked. */
  private async searchOutside(
    user: User,
    courseKey: string | null,
    wanted: string,
    jid: string,
    already: WebFind[],
  ): Promise<void> {
    const course = courseKey ? (courseDisplay(courseKey) ?? courseKey) : 'your course'
    // The code alone is a local invention — "575" matches Math 575 just as well — so
    // the stored title is what the search is actually about.
    const title = courseKey ? ((await courseService.find(courseKey))?.title ?? null) : null

    const found = await notifierService.withTyping(jid, () =>
      researchService.documentsFor(
        { code: course, title, words: wanted },
        already.map((item) => item.url),
      ),
    )

    if (found.length === 0) {
      // Nothing new, but something already found. Saying only "I couldn't find
      // anything" leaves them empty-handed over a list they may never have seen — the
      // message carrying it can be lost to a dropped socket, and asking again is
      // exactly what somebody does when that happens.
      if (already.length > 0) {
        await conversationService.rememberFindings(user.phone, already)
        await this.say(
          user.phone,
          jid,
          `Nothing new beyond what I already found. Here it is again 👇

${listFindings(already)}`,
        )
        return
      }

      await conversationService.rememberFindings(user.phone, [])
      // Named, because "nothing found" for a course whose subject Peermate does not
      // know is a different problem from one where the web genuinely has nothing.
      const about = title ?? wanted
      await this.say(
        user.phone,
        jid,
        `I looked, but I couldn't find a PDF ${about ? `about *${about}*` : `for *${course}*`} worth sending.

${about ? "Tell me the topic more exactly and I'll try again" : `Tell me what *${course}* is actually about — the course title — and I'll search on that instead`}.`,
      )
      return
    }

    const findings = found.map((item, index) => ({
      position: index + 1,
      title: item.title,
      url: item.url,
    }))
    await conversationService.rememberFindings(user.phone, findings)

    await this.say(
      user.phone,
      jid,
      `Found ${findings.length} PDF${findings.length === 1 ? '' : 's'} on *${course}* 🌐

${listFindings(findings)}`,
    )
  }

  /** Downloads and forwards what they picked. Nothing is stored. */
  private async sendFound(
    user: User,
    findings: WebFind[],
    positions: number[],
    jid: string,
  ): Promise<void> {
    const picked =
      positions.length > 0 ? findings.filter((item) => positions.includes(item.position)) : findings

    if (picked.length === 0) {
      await this.say(user.phone, jid, `There's no ${positions.join(' or ')} in that list.`)
      return
    }

    const failed: string[] = []
    let sent = 0

    await notifierService.withTyping(jid, async () => {
      for (const item of picked) {
        const file = await researchService.download(item.url)
        if (!file) {
          failed.push(item.title)
          continue
        }
        await notifierService.sendDocument(
          jid,
          file.bytes,
          file.fileName,
          PDF_MIME,
          `${item.title}\n\n_From the web, not from your group._`,
        )
        sent += 1
      }
    })

    // Named, not counted: "1 failed" leaves them wondering which one, and the link is
    // still in the list above for them to open themselves.
    if (failed.length > 0) {
      await this.say(
        user.phone,
        jid,
        `${sent > 0 ? `Sent ${sent}. ` : ''}I couldn't download ${failed.map((title) => `*${title}*`).join(', ')} — the link didn't give back a PDF. You can still open it from the list above.`,
      )
    }
  }

  /**
   * Revision from the files people shared, rather than from the model's own memory.
   *
   * Built once and kept: the same material asked twice produces different questions,
   * so rebuilding per turn would make the running score meaningless.
   */
  private async prep(
    user: User,
    text: string,
    scoped: string | null,
    jid: string,
  ): Promise<string | null> {
    const held = await conversationService.quiz(user.phone)
    const wantsQuestions = ASKS_TO_BE_QUIZZED.test(text)

    // "Quiz me" on its own, straight after a brief — the set is already built.
    if (wantsQuestions && held && (!scoped || held.courseKey === scoped)) {
      await conversationService.setQuiz(user.phone, held, true)
      return prepService.ask(held)
    }

    const courseKey = scoped ?? held?.courseKey ?? null
    if (!courseKey) {
      return `Which course should I prep you for? Send the code — *prep me for CVE 575*.`
    }

    const course = courseDisplay(courseKey) ?? courseKey
    const built = await notifierService.withTyping(jid, () => prepService.brief(user, courseKey))

    // Nothing to work from. Saying so beats a page of plausible questions about a
    // course Peermate has never seen a single slide of.
    if (!built) {
      return `I don't have any readable material for *${course}* yet — no slides, notes or past questions have been shared in that group.

Send me the files yourself, or ask in the group for someone to post them, and I'll build you a practice set from them.`
    }

    if (wantsQuestions) {
      await conversationService.setQuiz(user.phone, built.quiz, true)
      return prepService.ask(built.quiz)
    }

    await conversationService.setQuiz(user.phone, built.quiz)
    return built.text
  }

  /** One answer, marked, and the next question — or the score when they are done. */
  private async markQuizAnswer(user: User, quiz: Quiz, text: string, jid: string): Promise<void> {
    if (ENDS_QUIZ.test(text.trim())) {
      await conversationService.setQuiz(user.phone, null)
      await this.say(user.phone, jid, prepService.score(quiz))
      return
    }

    const { reply, next } = await notifierService.withTyping(jid, () =>
      prepService.mark(quiz, text),
    )
    const finished = next.index >= next.questions.length
    // Kept rather than cleared when it finishes: "ask me those again" should not have
    // to pay for a fresh set, and the questions are still the right ones.
    await conversationService.setQuiz(user.phone, next, !finished)
    await this.say(user.phone, jid, reply)
  }

  /**
   * Shows the transcript when a spoken message could not be understood.
   *
   * A voice note the student cannot see transcribed is a black box: "I'm not sure
   * what you're after" leaves them unable to tell whether Peermate misunderstood the
   * request or simply misheard the words. Reading it back turns a dead end into an
   * obvious correction.
   */
  private heard(text: string, spoken: boolean): string {
    if (!spoken) return ''
    const words = text.replace(/\s+/g, ' ').trim()
    if (!words) return ''
    return `I heard: _"${words}"_\n\n`
  }

  private whichCourse(user: User): string {
    const list = user.courseKeys.map((key) => `• *${courseDisplay(key)}*`).join('\n')
    return `Which one? You're watching:\n\n${list}`
  }

  private unsupported(user: User): string {
    const watching =
      user.courseKeys.length > 0
        ? `\n\nYou're watching ${user.courseKeys.map(courseDisplay).join(', ')}.`
        : ''
    return `That's outside what I do — I only know what's been said in your course groups since I joined.

I can tell you what was announced, send the files people shared, and give you a rundown of what you missed.${watching}

Send *help* to see everything.`
  }

  /**
   * A greeting, but not a blank one.
   *
   * "It is done" after proposing a group is an acknowledgement, and answering it
   * with "what do you need?" reads as though Peermate forgot the conversation it
   * was just having. If something is still waiting, say so.
   */
  private async smalltalk(user: User): Promise<string> {
    const hello = user.displayName ? `Hi ${user.displayName} 👋` : 'Hi 👋'

    const waiting = await groupRepository.pending()
    const proposed = waiting.filter((group) => group.proposedCourse)
    if (proposed.length > 0) {
      const names = proposed
        .map((group) => `*${group.name ?? 'a group'}* (${group.proposedCourse})`)
        .join(', ')
      return `${hello}\n\nStill waiting on approval for ${names} — I'm not reading it yet. I'll message you the moment it's live.`
    }

    const connected = await groupRepository.approved()
    if (connected.length === 0) {
      return `${hello}\n\nI'm not reading any group yet. Add me to one and tell me which course it's for.`
    }

    return `${hello} What do you need?`
  }

  /**
   * A student saying which course a group belongs to.
   *
   * They are the one who knows — they added Peermate to it. They cannot approve it,
   * because anybody can add the bot anywhere, but their answer is recorded and
   * relayed so the operator is not deciding blind.
   */
  private async linkGroup(user: User, text: string): Promise<string> {
    const waiting = await groupRepository.pending()
    if (waiting.length === 0) {
      const live = await groupRepository.approved()
      return live.length > 0
        ? `I'm already reading ${live.length} group${live.length === 1 ? '' : 's'}. Nothing new is waiting to be set up.`
        : "I haven't been added to any group yet. Add me to one and I'll pick it up."
    }

    const named = waiting.find((group) =>
      group.name ? text.toLowerCase().includes(group.name.toLowerCase()) : false,
    )
    const group = named ?? waiting[0]!

    const [key] = parseCourseList(text)
    if (!key) {
      return `I've been added to *${group.name ?? 'a group'}* and it's waiting to be set up. Which course is it for? Send the code, like *CVE 575*.`
    }

    // Read back before relaying. What gets confirmed here decides where every
    // announcement from that group is filed for the rest of the semester, and the
    // student cannot see what "Cve 575" or a photographed code became — a misread
    // shows up weeks later as alerts that never arrive.
    return this.confirmGroupCourse(user, group, courseDisplay(key) ?? key)
  }

  private async confirmGroupCourse(user: User, group: Group, course: string): Promise<string> {
    await conversationService.proposeGroup(user.phone, {
      chatJid: group.chatJid,
      groupName: group.name,
      course,
    })

    const others = (await groupRepository.pending()).filter(
      (other) => other.chatJid !== group.chatJid,
    )
    const ambiguity =
      others.length > 0
        ? `\n\n_I picked *${group.name ?? 'that group'}* out of ${others.length + 1} waiting. If you meant another one, say its name._`
        : ''

    return `Just so I get this right — *${group.name ?? 'that group'}* is the group for *${course}*?

Send *yes* and I'll pass it on. If the code is wrong, just send the right one.${ambiguity}`
  }

  /** The yes, the correction, or the no. */
  private async resolveGroupProposal(
    user: User,
    proposal: NonNullable<Conversation['proposal']>,
    text: string,
  ): Promise<string | null> {
    // A different code is a correction, not a refusal — take it and ask again rather
    // than making them say no first.
    const [corrected] = parseCourseList(text)
    if (corrected && (courseDisplay(corrected) ?? corrected) !== proposal.course) {
      const group = await groupRepository.findByJid(proposal.chatJid)
      if (!group) return null
      return this.confirmGroupCourse(user, group, courseDisplay(corrected) ?? corrected)
    }

    if (DECLINED.test(text)) {
      await conversationService.proposeGroup(user.phone, null)
      return `No problem — which course is *${proposal.groupName ?? 'that group'}* for? Send the code, like *CVE 575*.`
    }

    if (!AGREED.test(text) && !corrected) return null

    await conversationService.proposeGroup(user.phone, null)
    await groupService.propose(proposal.chatJid, proposal.course, user.displayName ?? user.phone)

    const key = courseKey(proposal.course)
    const mine = key ? user.courseKeys.includes(key) : false
    const tail = mine
      ? `You're taking ${proposal.course}, so once it's approved you'll get everything from it.`
      : `You're not registered for ${proposal.course} — send *add ${proposal.course}* if you want its announcements.`

    return `Noted — *${proposal.groupName ?? 'that group'}* is for *${proposal.course}*.

I'm not reading it yet: a group has to be approved before I look at anything in it. I've passed this on, and I'll start listening as soon as it's approved.

${tail}`
  }

  private async liftPause(user: User): Promise<User> {
    const resumed = { ...user, pausedUntil: null }
    await userRepository.upsert(resumed)
    logger.info({ phone: user.phone }, 'pause expired')
    return resumed
  }

  /** Rewrites "I'm also taking MTH 101 now" into the form the command matcher reads. */
  private asCommand(routed: Routed, text: string): string {
    switch (routed.intent) {
      case 'add_course':
        return `add ${text}`
      case 'remove_course':
        return `remove ${text}`
      case 'list_courses':
        return 'my courses'
      case 'change_settings':
        return `settings ${text}`
      // The original wording rides along: "until Monday" and "the morning ones" are
      // what tell the command how long, and how much, to go quiet for.
      case 'pause_alerts':
        return `pause ${text}`
      case 'resume_alerts':
        return `resume ${text}`
      case 'change_name':
        return routed.newName ? `call me ${routed.newName}` : 'change my name'
      default:
        return 'help'
    }
  }
}

export const dmService = new DmService()
