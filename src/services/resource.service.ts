import { logger } from '../core/logger.js'
import type { DocType, RememberedFile, Resource, User } from '../models/index.js'
import { resourceRepository } from '../repositories/index.js'
import { courseDisplay, parseCourseList } from '../utils/courses.js'
import { conversationService } from './conversation.service.js'
import { notifierService } from './notifier.service.js'

/**
 * Asking for files, as opposed to asking a question that happens to mention one.
 *
 * A bare noun is not a request: "what did the lecturer say in the voice *note*?" and
 * "is there a *file* for this?" are questions, and answering them by dumping every
 * stored document is worse than useless. So a match needs either an explicit plural
 * noun that only means the library ("resources", "materials", "past questions"), or
 * a verb of asking paired with a file noun.
 */
const EXPLICIT =
  /\b(resources?|materials?|past\s*questions?|course\s*(files?|documents?|notes?))\b/i
const ASK_FOR_FILES =
  /\b(send|share|give|upload|post|get|need|want|have|drop|forward)\b[^.?!]{0,30}\b(files?|slides?|notes?|documents?|pdfs?|briefs?|papers?)\b/i
/** Past this, a shelf is a flood — ask which kind instead of sending everything. */
const MAX_AUTO_SEND = 6

const WHAT_FILES = /\b(what|which|any)\b[^.?!]{0,20}\b(files?|slides?|notes?|documents?|pdfs?)\b/i

/**
 * The library assembled itself — nobody curated it. It exists because Peermate was
 * in the room when each file arrived. A request comes back as the actual files, not
 * a list of links.
 */
export class ResourceService {
  looksLikeRequest(text: string): boolean {
    return EXPLICIT.test(text) || ASK_FOR_FILES.test(text) || WHAT_FILES.test(text)
  }

  /**
   * A vague request across several courses would send every file the student has
   * access to — a flood of attachments on metered data. Ask which course instead.
   */
  needsCourse(user: User, text: string): boolean {
    const named = parseCourseList(text).filter((key) => user.courseKeys.includes(key))
    return named.length === 0 && user.courseKeys.length > 1
  }

  async courseMenu(user: User): Promise<string> {
    const lines: string[] = ['Which course?', '']
    for (const key of user.courseKeys) {
      const count = (await resourceRepository.forCourse(key)).length
      lines.push(`• *${courseDisplay(key)}* — ${count} file${count === 1 ? '' : 's'}`)
    }
    lines.push('', 'Reply with the course code, like *CSC 301*.')
    // Recorded, not inferred. A bare "CSC 301" is an answer only because something
    // was asked, and leaving that to the router makes it a coin flip.
    await conversationService.expect(user.phone, 'awaiting_resource_course')
    return lines.join('\n')
  }

  /**
   * Picks out of the list just shown: "send the second one", "send all".
   *
   * Positions refer to what the student can see on their screen, so they only mean
   * anything while that list is still the last thing discussed.
   */
  async pickFromLast(
    user: User,
    positions: number[],
    sendAll: boolean,
  ): Promise<{ error: string | null; summary: string; files: RememberedFile[] }> {
    const remembered = (await conversationService.get(user.phone))?.files ?? []
    if (remembered.length === 0) {
      return {
        error:
          "I haven't listed any files recently. Say *CSC 301 resources* and I'll show you what there is.",
        summary: '',
        files: [],
      }
    }

    if (sendAll) {
      return {
        error: null,
        summary: `Sending all ${remembered.length} 👇`,
        files: remembered,
      }
    }

    const picked = remembered.filter((file) => positions.includes(file.position))
    if (picked.length === 0) {
      return {
        error: `There's no number ${positions.join(' or ')} in that list — it had ${remembered.length}. Try again, or say *send all*.`,
        summary: '',
        files: [],
      }
    }

    return {
      error: null,
      summary: `Sending ${picked.map((file) => file.fileName).join(', ')} 👇`,
      files: picked,
    }
  }

  /** Sends files the student picked by position, reporting honestly on failures. */
  async sendRemembered(user: User, files: RememberedFile[]): Promise<string | null> {
    const failed: string[] = []
    for (const file of files) {
      try {
        await notifierService.sendFile(
          user.jid,
          file.mediaKey,
          file.fileName,
          file.mimeType ?? undefined,
        )
      } catch (error) {
        logger.error({ err: error, mediaKey: file.mediaKey }, 'failed to send picked file')
        failed.push(file.fileName)
      }
    }
    return this.reportFailures(files.length, failed)
  }

  /**
   * Names what did not arrive.
   *
   * Silently sending three of four files is the failure mode that wastes the most
   * of someone's time: they do not know a file is missing, so they never ask again.
   */
  private reportFailures(attempted: number, failed: string[]): string | null {
    if (failed.length === 0) return null
    if (failed.length === attempted) {
      return `I couldn't send ${failed.length === 1 ? 'that file' : 'those files'}. Ask again and I'll retry.`
    }
    return `I sent ${attempted - failed.length} of ${attempted}. ${failed.join(', ')} failed — ask for ${failed.length === 1 ? 'it' : 'them'} again and I'll retry.`
  }

  /** The shelf listing. Files are sent afterwards by sendFiles(). */
  async shelf(
    user: User,
    text: string,
    scoped: string | null = null,
    docType: DocType | 'any' = 'any',
  ): Promise<{ summary: string; files: Resource[]; tooMany: boolean }> {
    const asked = scoped ? [scoped] : parseCourseList(text)
    const mine = asked.filter((key) => user.courseKeys.includes(key))

    // A course they did not register is still worth answering when the files exist.
    // Cohorts overlap almost completely here, and refusing a classmate's past
    // questions on a registration technicality helps nobody.
    const borrowed: string[] = []
    for (const key of asked.filter((key) => !mine.includes(key))) {
      if ((await resourceRepository.forCourse(key)).length > 0) borrowed.push(key)
    }

    const targets = asked.length > 0 ? [...mine, ...borrowed] : user.courseKeys

    if (targets.length === 0) {
      const named = asked.map(courseDisplay).filter(Boolean).join(', ')
      return {
        summary: named
          ? `You're not watching ${named} and nothing has been shared for it either. Send *add ${named}* if you want me to start watching.`
          : "That course isn't on your list. Send me the code and I'll check.",
        files: [],
        tooMany: false,
      }
    }

    const lines: string[] = []
    const files: Resource[] = []

    for (const key of targets) {
      const all = await resourceRepository.forCourse(key)
      const resources = docType === 'any' ? all : all.filter((item) => item.docType === docType)
      if (resources.length === 0) continue

      lines.push(
        `*${courseDisplay(key)}* — ${resources.length} item${resources.length === 1 ? '' : 's'}`,
      )
      for (const resource of resources) {
        const when = resource.postedAt.toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
        })
        lines.push(`• ${resource.fileName} _(${resource.postedBy ?? 'unknown'}, ${when})_`)
      }
      lines.push('')
      files.push(...resources)
    }

    if (files.length === 0) {
      const names = targets.map(courseDisplay).filter(Boolean).join(', ')
      const kind = docType === 'any' ? '' : ` ${docType.replace('_', ' ')}`
      return {
        summary: `No${kind} files have been shared in ${names} since I joined.`,
        files: [],
        tooMany: false,
      }
    }

    // Sending twenty attachments unasked would bury the chat and the data bundle.
    const tooMany = files.length > MAX_AUTO_SEND
    if (tooMany) {
      const kinds = [...new Set(files.map((file) => file.docType))]
        .filter((kind) => kind !== 'other')
        .map((kind) => `• *${kind.replace('_', ' ')}*`)
      lines.push(
        `That's a lot to send at once. Tell me which you want:`,
        ...kinds,
        '• *send all* — every one of them',
        '',
        'Or pick from the list, like *send 2*.',
      )
      return { summary: lines.join('\n').trim(), files, tooMany }
    }

    if (borrowed.length > 0) {
      lines.push(
        `_You're not registered for ${borrowed.map(courseDisplay).join(', ')} — these were shared anyway._`,
      )
    }
    lines.push(`Sending ${files.length} file${files.length === 1 ? '' : 's'} now 👇`)
    return { summary: lines.join('\n').trim(), files, tooMany }
  }

  /** Called after the shelf text, so the student knows what is arriving and why. */
  async sendFiles(user: User, files: Resource[]): Promise<number> {
    let sent = 0
    const failed: string[] = []

    for (const resource of files) {
      try {
        await notifierService.sendFile(
          user.jid,
          resource.mediaKey,
          resource.fileName,
          resource.mimeType ?? undefined,
        )
        sent += 1
      } catch (error) {
        // One unreadable file must not cost the student the rest of the shelf.
        logger.error({ err: error, mediaKey: resource.mediaKey }, 'failed to send resource')
        failed.push(resource.fileName)
      }
    }

    const report = this.reportFailures(files.length, failed)
    if (report) await notifierService.sendText(user.jid, report)

    logger.info({ phone: user.phone, sent, of: files.length }, 'resources delivered')
    return sent
  }
}

export const resourceService = new ResourceService()
