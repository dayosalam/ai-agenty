import { explain } from '../core/failures.js'
import { logger } from '../core/logger.js'
import type { Conversation, Group, Message, User } from '../models/index.js'
import { groupRepository, messageRepository, userRepository } from '../repositories/index.js'
import { config } from '../config.js'
import { getMedia } from '../db/minio.js'
import { courseDisplay, courseKey, parseCourseList } from '../utils/courses.js'
import { formatStamp } from '../utils/dates.js'
import { jidToIdentity } from '../whatsapp/jid.js'
import { adminService } from './admin.service.js'
import { conversationService } from './conversation.service.js'
import { DeliveryService } from './delivery.service.js'
import { digestService } from './digest.service.js'
import { groupService } from './group.service.js'
import { guidanceService } from './guidance.service.js'
import { notifierService } from './notifier.service.js'
import { onboardingService } from './onboarding.service.js'
import { qaService } from './qa.service.js'
import { resourceService } from './resource.service.js'
import { routerService, type Routed } from './router.service.js'
import { studentCommandsService } from './student-commands.service.js'

/** Below this the model is guessing, and asking beats acting on a guess. */
const MIN_CONFIDENCE = 0.5

const NOT_AN_OPERATOR = `That's a setup command — only whoever runs Peermate can use it.

If a group needs connecting, tell me which course it's for and I'll pass it on. Send *help* for what you can do.`

const AGREED =
  /^(yes|yeah|yep|yh|correct|right|exactly|that'?s (it|right)|sure|ok(ay)?|na so|👍)\b/i
const DECLINED = /^(no|nope|nah|wrong|not (that|it)|different|another)\b/i

/** One pictograph or several, with nothing else in the message. */
const EMOJI_ONLY = /^(?:[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}]|\s)+$/u
const PUZZLED = /[\u{2753}\u{2754}\u{1F914}\u{1F615}\u{1F644}\u{1F928}]/u

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
      await notifierService.sendText(
        message.chatJid,
        message.type === 'image' || message.type === 'audio'
          ? "I couldn't make anything out of that. Could you send it again, or type it out?"
          : 'Ask me something like *"when is the CSC 301 test?"*',
      )
      return
    }

    // An answer to a question Peermate asked, before anything reinterprets it.
    if (await this.answerPending(user, text, message.chatJid)) return

    // Exact commands first: zero latency, zero cost, and no chance of a model
    // reinterpreting a word the student meant literally.
    const command = await studentCommandsService.handle(user, text)
    if (command) {
      await notifierService.sendText(message.chatJid, command)
      return
    }

    if (adminService.looksLikeOperatorCommand(text)) {
      await notifierService.sendText(message.chatJid, NOT_AN_OPERATOR)
      return
    }

    // "How do I approve it?" is a question about Peermate, not about a course.
    // Routed as a question it searches the group archive, finds nothing, and says so
    // — which reads as broken to somebody who was asking for instructions.
    if (guidanceService.looksLikeAboutPeermate(text)) {
      const how = await guidanceService.answer(user, text, adminService.isOperator(phone))
      await notifierService.sendText(message.chatJid, how)
      await conversationService.rememberQuestion(phone, text, how)
      return
    }

    const emoji = reactionTo(text)
    if (emoji !== 'not-emoji') {
      // A thumbs-up is an acknowledgement, and replying to one is what makes a bot
      // exhausting to talk to. Only a puzzled face is actually asking something.
      if (emoji === 'puzzled') {
        await notifierService.sendText(
          message.chatJid,
          'Not sure what you need — ask me something like *"when is the CSC 301 test?"*, or send *help*.',
        )
      }
      return
    }

    try {
      // Typing stays visible for the whole call, not just the first ten seconds.
      const reply = await notifierService.withTyping(message.chatJid, () =>
        this.respond(user, text, message.chatJid, message.type === 'audio'),
      )
      if (reply) {
        await notifierService.sendText(message.chatJid, reply)
        await conversationService.rememberQuestion(phone, text, reply)
      }
    } catch (error) {
      // Say what actually failed. "Something went wrong" makes an outage
      // indistinguishable from a question that simply has no answer.
      logger.error({ err: error, phone }, 'dm handling failed')
      await notifierService.sendText(message.chatJid, explain(error))
    }
  }

  /** Returns the text to send, or null when the branch already replied itself. */
  private async respond(
    user: User,
    text: string,
    jid: string,
    spoken: boolean,
  ): Promise<string | null> {
    const context = await conversationService.summarise(user.phone)
    const routed = await routerService.route(text, context)

    const resolved = await this.resolveCourse(user, routed)
    if (resolved.ask) return resolved.ask
    if (resolved.courseKey) await conversationService.rememberCourse(user.phone, resolved.courseKey)

    if (routed.confidence < MIN_CONFIDENCE) {
      return routed.isFollowUp
        ? `${this.heard(text, spoken)}I'm not sure what that's about — we haven't talked about anything recently. Which course, and what would you like to know?`
        : `${this.heard(text, spoken)}I'm not sure what you're after. Do you want:\n\n• an answer about something that was announced\n• the files for a course\n• a rundown of what's been happening\n\nJust say which, or send *help*.`
    }

    const reply = await this.act(user, text, jid, routed, resolved.courseKey)

    // Only one request can be acted on, so say plainly which one was. Silence about
    // the second half reads as not having understood it.
    if (reply && routed.secondRequest) {
      return `${reply}\n\n_You also asked me to ${routed.secondRequest.replace(/^(to|please)\s+/i, '')} — ask me that on its own and I'll do it._`
    }
    return reply
  }

  private async act(
    user: User,
    text: string,
    jid: string,
    routed: Routed,
    scoped: string | null,
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

      case 'smalltalk':
        return this.smalltalk(user)

      default: {
        // A question about one course searches only that course, so "what about
        // STA?" after a CSC answer does not drag the CSC messages back in.
        const scope = scoped ? [scoped] : user.courseKeys
        // "Where is it?" is about the alert they were just sent, not about every
        // venue ever mentioned in the course.
        const focus = routed.isFollowUp ? await conversationService.focus(user.phone) : null
        return qaService.answer(text, scope, focus)
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
  ): Promise<{ courseKey: string | null; ask: string | null }> {
    const named = courseKey(routed.courseCode)

    if (named && user.courseKeys.includes(named)) return { courseKey: named, ask: null }

    if (named) {
      // They named something real but not theirs — a typo, or a course they dropped.
      const near = user.courseKeys.find((key) => key.slice(0, 3) === named.slice(0, 3))
      return {
        courseKey: null,
        ask: near
          ? `You're not watching *${courseDisplay(named)}*. Did you mean *${courseDisplay(near)}*? Send *add ${courseDisplay(named)}* if you want it too.`
          : `You're not watching *${courseDisplay(named)}*. Send *add ${courseDisplay(named)}* and I'll start including it.`,
      }
    }

    const needsCourse = routed.intent === 'ask_question' || routed.intent === 'request_resources'
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

    if (conversation?.pendingAction === 'confirm_group_course' && conversation.proposal) {
      const reply = await this.resolveGroupProposal(user, conversation.proposal, text)
      if (!reply) return false
      await notifierService.sendText(jid, reply)
      await conversationService.rememberQuestion(user.phone, text, reply)
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
      await notifierService.sendText(jid, shelf.summary)
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
      await notifierService.sendText(jid, picked.summary)
      return resourceService.sendRemembered(user, picked.files)
    }

    if (resourceService.needsCourse(user, text) && !scoped) return resourceService.courseMenu(user)

    const shelf = await resourceService.shelf(user, text, scoped, routed.docType)
    await notifierService.sendText(jid, shelf.summary)

    if (shelf.files.length > 0) {
      await conversationService.rememberFiles(user.phone, shelf.files)
      // A twenty-file course would flood the chat and the student's data bundle;
      // the shelf asks them to narrow it instead.
      if (!shelf.tooMany) await resourceService.sendFiles(user, shelf.files)
    }
    return null
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
