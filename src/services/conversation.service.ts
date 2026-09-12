import { config } from '../config.js'
import type {
  Conversation,
  Extraction,
  Message,
  RememberedFile,
  Quiz,
  Resource,
  Turn,
  WebFind,
} from '../models/index.js'
import {
  conversationRepository,
  extractionRepository,
  messageRepository,
} from '../repositories/index.js'
import { courseDisplay } from '../utils/courses.js'
import { formatDateTime } from '../utils/dates.js'

/** Older than this, a pronoun refers to nothing anyone remembers. */
const STALE_MS = 45 * 60 * 1000

/** Enough alerts that a student scrolling back a few days can still reply to one. */
const ALERTS_KEPT = 50

/** Twenty exchanges, both halves of each. Outlives STALE_MS — see the model. */
const TURNS_KEPT = 40

/** Enough to recognise what was said; short enough that forty of them fit a prompt. */
const TURN_MAX_CHARS = 500

/**
 * The last thing the student and Peermate were talking about.
 *
 * Follow-ups are the normal case, not the exception: nobody asks "where is the
 * CSC 301 test on Friday?" twice in a row — the second question is "where is it?".
 * Without a referent that question is unanswerable, and answering it wrongly is
 * worse than admitting the gap.
 */
export class ConversationService {
  async get(phone: string): Promise<Conversation | null> {
    const conversation = await conversationRepository.find(phone)
    if (!conversation) return null
    // Expired context is worse than none — it answers about the wrong thing.
    if (Date.now() - conversation.updatedAt.getTime() > STALE_MS) return null
    return conversation
  }

  /** A one-line summary for the router, so it can resolve references itself. */
  async summarise(phone: string): Promise<string | null> {
    const conversation = await this.get(phone)
    if (!conversation) return null

    const parts: string[] = []
    if (conversation.courseKey) parts.push(`course: ${courseDisplay(conversation.courseKey)}`)
    if (conversation.lastQuestion) parts.push(`they asked: "${conversation.lastQuestion}"`)
    if (conversation.lastAnswer) {
      // Truncated on purpose: the router needs to know an answer exists so it can
      // read "repeat that" and "are you sure?", not to re-read the whole answer.
      parts.push(`I last told them: "${conversation.lastAnswer.slice(0, 160)}"`)
    }
    if (conversation.files.length > 0) {
      const listed = conversation.files
        .map((file) => `${file.position}. ${file.fileName}`)
        .join('; ')
      parts.push(`files just listed: ${listed}`)
    }
    return parts.length > 0 ? parts.join(' | ') : null
  }

  /**
   * Adds one message to the running thread.
   *
   * Both directions, and every reply rather than only the ones a model produced: a
   * student asking "what did you tell me about the venue?" means whatever Peermate
   * actually sent, which is as often a file listing or a command reply.
   */
  async rememberTurn(phone: string, role: Turn['role'], text: string): Promise<void> {
    const said = text.trim()
    if (!said) return

    const existing = (await conversationRepository.find(phone))?.turns ?? []
    const turn: Turn = {
      role,
      text: said.length > TURN_MAX_CHARS ? `${said.slice(0, TURN_MAX_CHARS)}…` : said,
      at: new Date(),
    }
    await this.merge(phone, { turns: [...existing, turn].slice(-TURNS_KEPT) })
  }

  /**
   * The thread as a prompt block, oldest first and the newest at the bottom.
   *
   * Read past STALE_MS on purpose. Each line is stamped, so a model can see that an
   * exchange was three days ago and weigh it accordingly instead of treating it as
   * something just said.
   */
  async transcript(phone: string, keep: number, chars: number): Promise<string | null> {
    const turns = (await conversationRepository.find(phone))?.turns ?? []
    if (turns.length === 0) return null

    return turns
      .slice(-keep)
      .map((turn) => {
        const said = turn.text.length > chars ? `${turn.text.slice(0, chars)}…` : turn.text
        const who = turn.role === 'student' ? 'They said' : 'I replied'
        return `[${formatDateTime(turn.at, config.digest.timezone)}] ${who}: ${said.replace(/\n+/g, ' ')}`
      })
      .join('\n')
  }

  async rememberQuestion(phone: string, question: string, answer: string): Promise<void> {
    await this.merge(phone, { lastQuestion: question, lastAnswer: answer })
  }

  async rememberCourse(phone: string, courseKey: string | null): Promise<void> {
    if (!courseKey) return
    await this.merge(phone, { courseKey })
  }

  /** After an announcement or an answer, so "where is it?" has an antecedent. */
  async rememberEvent(phone: string, extraction: Extraction): Promise<void> {
    await this.merge(phone, {
      courseKey: extraction.courseKey,
      eventId: extraction.eventId,
      sourceMessageId: extraction.sourceMessageId,
    })
  }

  /**
   * The event a follow-up is about, with the message it came from.
   *
   * Returns null rather than a stale referent: answering "where is it?" against
   * whatever was discussed an hour ago is worse than admitting there is nothing to
   * point at.
   */
  async focus(phone: string): Promise<{ extraction: Extraction; source: Message | null } | null> {
    const conversation = await this.get(phone)
    if (!conversation?.eventId) return null

    const extraction = await extractionRepository.findByEventId(conversation.eventId)
    if (!extraction) return null

    const source = conversation.sourceMessageId
      ? await messageRepository.findById(conversation.sourceMessageId)
      : null
    return { extraction, source }
  }

  /** The exact thing Peermate last said, for "repeat that". */
  async lastAnswer(phone: string): Promise<string | null> {
    return (await this.get(phone))?.lastAnswer ?? null
  }

  /** After listing a shelf, so "send the second one" means something. */
  async rememberFiles(phone: string, resources: Resource[]): Promise<void> {
    const files: RememberedFile[] = resources.map((resource, index) => ({
      position: index + 1,
      fileName: resource.fileName,
      mediaKey: resource.mediaKey,
      mimeType: resource.mimeType,
      courseKey: resource.courseKey,
    }))
    await this.merge(phone, { files, courseKey: resources[0]?.courseKey ?? null })
  }

  /**
   * Marks the student as mid-conversation, whatever they sent.
   *
   * DeliveryService reads `updatedAt` to decide whether an alert would land in the
   * middle of an exchange, and without this only a question counted as talking — so
   * an announcement arriving two seconds after a *pause* command still cut in.
   */
  async touch(phone: string): Promise<void> {
    await this.merge(phone, {})
  }

  /** Parks a command that needs one word back before it does anything. */
  async expect(phone: string, action: Conversation['pendingAction']): Promise<void> {
    await this.merge(phone, { pendingAction: action })
  }

  /** Holds a timetable read from a photograph until the student confirms it. */
  async proposeTimetable(phone: string, timetable: unknown): Promise<void> {
    await this.merge(phone, {
      timetable,
      pendingAction: timetable ? 'confirm_timetable' : null,
    })
  }

  /** Holds a group-and-course pairing until the student confirms it is right. */
  async proposeGroup(phone: string, proposal: Conversation['proposal']): Promise<void> {
    await this.merge(phone, { proposal, pendingAction: proposal ? 'confirm_group_course' : null })
  }

  /**
   * Ties an alert Peermate just sent to the event it was about.
   *
   * Kept per student because the id is per delivery: the same announcement sent to
   * thirty students is thirty different messages, and each of them can be replied to.
   */
  async rememberAlert(phone: string, waMessageId: string, eventId: string): Promise<void> {
    const existing = (await conversationRepository.find(phone))?.alerts ?? []
    await this.merge(phone, {
      alerts: [...existing, { waMessageId, eventId }].slice(-ALERTS_KEPT),
    })
  }

  /** The event a quoted alert was about, or null when the quote is something else. */
  async alertFor(phone: string, waMessageId: string): Promise<string | null> {
    const alerts = (await conversationRepository.find(phone))?.alerts ?? []
    return alerts.find((alert) => alert.waMessageId === waMessageId)?.eventId ?? null
  }

  /** Holds the request while Peermate asks whether to look outside the group. */
  async offerWebSearch(phone: string, wanted: string): Promise<void> {
    await this.merge(phone, { wanted, pendingAction: 'confirm_web_search' })
  }

  /** What a search turned up, waiting on which of them to send. */
  async rememberFindings(phone: string, findings: WebFind[]): Promise<void> {
    await this.merge(phone, {
      findings,
      pendingAction: findings.length > 0 ? 'choose_web_file' : null,
    })
  }

  /**
   * Starts, advances or ends a revision set. Null ends it.
   *
   * `asking` is what separates a quiz that has been built from one that is running:
   * a brief stores its questions so "quiz me" does not rebuild them, but until they
   * say that, an ordinary message is not an answer to anything.
   */
  async setQuiz(phone: string, quiz: Quiz | null, asking = false): Promise<void> {
    if (!quiz) return this.merge(phone, { quiz: null, pendingAction: null })
    await this.merge(phone, asking ? { quiz, pendingAction: 'answering_quiz' } : { quiz })
  }

  async quiz(phone: string): Promise<Quiz | null> {
    return (await this.get(phone))?.quiz ?? null
  }

  async forget(phone: string): Promise<void> {
    await conversationRepository.clear(phone)
  }

  private async merge(phone: string, patch: Partial<Conversation>): Promise<void> {
    const stored = await conversationRepository.find(phone)
    // Staleness clears the referents but never the thread: an expired "it" answers
    // about the wrong event, whereas an old transcript is only an old transcript.
    const fresh = stored && Date.now() - stored.updatedAt.getTime() <= STALE_MS ? stored : null

    await conversationRepository.save({
      phone,
      courseKey: null,
      eventId: null,
      sourceMessageId: null,
      files: [],
      lastAnswer: null,
      lastQuestion: null,
      pendingAction: null,
      proposal: null,
      timetable: null,
      quiz: null,
      alerts: stored?.alerts ?? [],
      findings: [],
      wanted: null,
      turns: stored?.turns ?? [],
      ...fresh,
      ...patch,
      updatedAt: new Date(),
    })
  }
}

export const conversationService = new ConversationService()
