import type {
  Conversation,
  Extraction,
  Message,
  RememberedFile,
  Resource,
} from '../models/index.js'
import {
  conversationRepository,
  extractionRepository,
  messageRepository,
} from '../repositories/index.js'
import { courseDisplay } from '../utils/courses.js'

/** Older than this, a pronoun refers to nothing anyone remembers. */
const STALE_MS = 45 * 60 * 1000

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

  /** Holds a group-and-course pairing until the student confirms it is right. */
  async proposeGroup(phone: string, proposal: Conversation['proposal']): Promise<void> {
    await this.merge(phone, { proposal, pendingAction: proposal ? 'confirm_group_course' : null })
  }

  async forget(phone: string): Promise<void> {
    await conversationRepository.clear(phone)
  }

  private async merge(phone: string, patch: Partial<Conversation>): Promise<void> {
    const existing = await this.get(phone)
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
      ...existing,
      ...patch,
      updatedAt: new Date(),
    })
  }
}

export const conversationService = new ConversationService()
