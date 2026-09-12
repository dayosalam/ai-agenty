import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { Extraction, Message } from '../models/index.js'
import { courseDisplay } from '../utils/courses.js'
import { describeAuthority } from '../utils/authority.js'
import { formatDateTime, formatTime12 } from '../utils/dates.js'
import { getOpenAI } from './openai.client.js'
import { retrievalService, type Candidate } from './retrieval.service.js'

/**
 * The thing the student was just told, when their question is a follow-up.
 *
 * "Where is it?" has no answer without it. Retrieval alone would find every venue
 * mentioned in the course and pick one, which is how a confident answer about the
 * wrong test gets sent.
 */
export interface Focus {
  extraction: Extraction
  source: Message | null
}

const SYSTEM = `You answer a university student's question using ONLY the group-chat messages provided.

Rules:
- Every claim must come from a provided message. If the messages do not answer the question, say so plainly — never invent a date, time or venue.
- Always cite the source given in brackets above each excerpt, exactly as written — who, in what form, and when. The citation is what makes the answer trustworthy, because the student never saw the original.
- Some excerpts come from a file someone shared. Cite those by filename and page, and say the student can ask for the file by name.
- An excerpt marked SCANNED came from reading a photographed page, so it may contain mistakes. Answer from it, but say plainly that it came from a scan and is worth checking against the file itself.
- An excerpt marked UNREADABLE means Peermate holds that file but could not read inside it. Never guess at its contents. Say that the file exists, that you cannot read it, and offer to send it.
- A later message usually corrects an earlier one. When one clearly supersedes another, answer with the current version and say what changed.
- Some sources are marked (lecturer) or (class rep). Their word outweighs a classmate's: lead with it, and mention the other version as what a classmate said.
- When two sources of the SAME standing genuinely disagree and neither is clearly later, DO NOT CHOOSE. Show both with their sources and tell the student to confirm with the lecturer.
- Be short. This is a WhatsApp DM, not an essay. Two or three lines is usually right.
- Always write times on a 12-hour clock — "10am", "5:30pm", "11:59pm" — never "17:00" or "23:59".
- Do not use markdown headings or bullet characters other than •. WhatsApp shows *bold* with single asterisks.
- The ABOUT THE STUDENT block is fact, not a message somebody sent. Use it freely to answer "when is my lecture?", "who teaches this?", "what have I got today?" — those answers come from their own record and need no citation. Never cite it as though somebody said it in a group.
- If that block says Peermate is in no group for a course, and the question is about that course, say exactly that rather than reporting an empty search. The student needs to know it cannot hear, not that nothing happened.
- THE CHAT SO FAR is your own earlier conversation with this student, not something said in a group. Use it to understand what they mean — "the one you mentioned", "you said Thursday", "the other course" — and to avoid repeating an answer they already have. Never cite it as a source for a fact about a course; if a claim's only support is your own earlier reply, say where that reply came from or say you are not sure.
- When a block is marked THIS IS WHAT THEY WERE JUST TOLD, the question is about that and nothing else. "Where is it?", "who said that?", "what time?", "are you sure?" all refer to it. Answer from that block first and use the other messages only to add to it. If the detail they asked for is genuinely not there — no venue was ever given, say — say that about this specific event rather than answering about a different one.`

export class QaService {
  async answer(
    question: string,
    courseKeys: string[],
    focus?: Focus | null,
    profile?: string | null,
    history?: string | null,
  ): Promise<string> {
    const candidates = await retrievalService.search(question, courseKeys)

    // A follow-up about a known event is answerable from the event itself, even when
    // retrieval finds nothing — the alert came from a stored row, not from a search.
    if (candidates.length === 0 && !focus) {
      const courses = courseKeys.map(courseDisplay).filter(Boolean).join(', ')
      return `I haven't heard anything about that yet in ${courses || 'your courses'}.\n\nI only know what was said in the groups after I joined them, so if it was announced before that, I missed it.`
    }

    const completion = await getOpenAI().chat.completions.create({
      model: config.openai.answerModel,
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            profile ? `ABOUT THE STUDENT:\n${profile}\n` : '',
            history
              ? `THE CHAT SO FAR (oldest first, their newest message last):\n${history}\n`
              : '',
            `Question: ${question}`,
            focus ? `\nTHIS IS WHAT THEY WERE JUST TOLD:\n${describeFocus(focus)}` : '',
            `\nMessages:\n${format(candidates)}`,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    })

    const answer = completion.choices[0]?.message.content?.trim()
    logger.info({ candidates: candidates.length, focused: Boolean(focus) }, 'answered question')
    return answer ?? "I couldn't work that out from what I've heard."
  }
}

/**
 * The remembered event, plus the words it was extracted from.
 *
 * Both matter and for different questions: the row answers "what time?", the
 * original wording answers "what did he say exactly?".
 */
function describeFocus(focus: Focus): string {
  const { extraction, source } = focus
  const course = courseDisplay(extraction.course ?? extraction.courseKey) ?? 'their course'
  const role = describeAuthority(extraction.authority)
  const when = [extraction.originalDateText ?? extraction.date, formatTime12(extraction.time)]
    .filter(Boolean)
    .join(' ')

  const lines = [
    `${course} ${extraction.eventType.replace('_', ' ')}${when ? ` — ${when}` : ''}${extraction.venue ? `, ${extraction.venue}` : ''}`,
    extraction.venue ? null : 'No venue was given for this one.',
    extraction.time ? null : 'No time was given for this one.',
  ].filter(Boolean)

  if (source) {
    const form =
      source.type === 'audio' ? 'voice note' : source.type === 'image' ? 'image' : 'message'
    const stamp = formatDateTime(source.timestamp, config.digest.timezone)
    lines.push(
      `Said by ${source.senderName ?? 'unknown'}${role ? ` (${role})` : ''}, ${form}, ${stamp}.`,
    )
    const words = source.text ?? source.transcript ?? source.caption
    if (words) lines.push(`Their exact words: "${words}"`)
  }

  if (extraction.corroboratedBy.length > 0) {
    lines.push(`${extraction.corroboratedBy.length} other people said the same thing.`)
  }

  return lines.join('\n')
}

/** Provenance comes from the stored row, never from the model. */
function format(candidates: Candidate[]): string {
  return candidates
    .slice()
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .map((candidate) => {
      const when = formatDateTime(candidate.timestamp, config.digest.timezone)
      const course = courseDisplay(candidate.courseKey) ?? 'unknown course'

      if (candidate.sourceKind === 'document') {
        const page = candidate.page ? `, page ${candidate.page}` : ''
        const flag =
          candidate.readVia === 'ocr'
            ? ' SCANNED'
            : candidate.readVia === 'none'
              ? ' UNREADABLE'
              : ''
        return `[${course} | ${candidate.fileName ?? 'shared file'}${page}, shared by ${candidate.senderName}, ${when}${flag}]\n${candidate.content}`
      }

      const form = candidate.type === 'audio' ? 'voice note' : candidate.type
      return `[${course} | ${candidate.senderName}, ${form}, ${when}]\n${candidate.content}`
    })
    .join('\n\n')
}

export const qaService = new QaService()
