import { zodResponseFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { DocType, type Message, type Resource } from '../models/index.js'
import { resourceRepository } from '../repositories/index.js'
import { courseDisplay, courseKey, parseCourseList } from '../utils/courses.js'
import { getOpenAI } from './openai.client.js'

const Tag = z.object({
  course: z.string().nullable(),
  docType: DocType,
  confidence: z.number(),
})

const SYSTEM = `You file documents shared in Nigerian university course group chats.

You are given a filename, any caption it was posted with, and the messages immediately before it. Decide which course it belongs to and what kind of document it is.

docType:
- "slides" — lecture slides or notes from the lecturer
- "past_questions" — past exam or test papers
- "assignment" — an assignment brief, coursework spec, or problem set to submit
- "textbook" — a book or long reference text
- "other" — anything else

Rules:
- Do NOT read or summarise the document. You are filing it, not studying it.
- The filename is usually the strongest signal. "CSC301_wk3_slides.pdf" is CSC 301 slides.
- If neither the filename, the caption, nor the surrounding messages name a course, return null. Never guess a course from the group's general topic.
- "confidence" is 0..1.`

/**
 * Tag, don't read — PRD §6.
 *
 * Peermate's value is that it kept the file and knows what it belongs to, not that it
 * parsed it. Filename plus surrounding messages identify course and type in one call;
 * there is no PDF parsing anywhere in this codebase.
 */
export class DocumentService {
  async file(
    message: Message,
    precedingTexts: string[],
    fallbackCourse: string | null,
  ): Promise<Resource | null> {
    if (message.type !== 'document' || !message.mediaKey) return null

    const fileName = message.fileName ?? `${message.waMessageId}.bin`
    const context = [
      `Filename: ${fileName}`,
      message.caption ? `Caption: ${message.caption}` : null,
      precedingTexts.length
        ? `Messages just before it:\n${precedingTexts.map((t) => `- ${t}`).join('\n')}`
        : null,
      fallbackCourse ? `This group is usually for ${fallbackCourse}.` : null,
    ]
      .filter(Boolean)
      .join('\n\n')

    const completion = await getOpenAI().beta.chat.completions.parse({
      model: config.openai.extractionModel,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: context },
      ],
      response_format: zodResponseFormat(Tag, 'document_tag'),
    })

    const tag = completion.choices[0]?.message.parsed
    if (!tag) return null

    // A code written in the filename is evidence, not a judgement call. The model
    // returned null for "CVE 565.pdf" while filing "Unilorin_CVE575_Course 1-3.pdf"
    // correctly, and a file with no course is invisible to every question about that
    // course — the student is told nothing was ever shared.
    const named = codeInName(fileName)
    const course = named ? (courseDisplay(named) ?? named) : (tag.course ?? fallbackCourse)
    const resource: Resource = {
      course,
      courseKey: courseKey(course),
      docType: tag.docType,
      fileName,
      mediaKey: message.mediaKey,
      mimeType: message.mimeType,
      postedBy: message.senderName,
      postedAt: message.timestamp,
      sourceMessageId: message.waMessageId,
    }

    await resourceRepository.insert(resource)
    logger.info(
      { fileName, courseKey: resource.courseKey, docType: resource.docType },
      'document filed',
    )
    return resource
  }
}

/**
 * Things that parse as a course code but are not one.
 *
 * "Assignment 2023" yields MENT2023 and "scan001.pdf" yields SCAN001 — a year is not a
 * course number, and neither is a sequence number, which is what a leading zero means.
 */
const NOT_A_COURSE = /^[A-Z]+((19|20)\d{2}|0\d+)$/

/**
 * The one course code a filename names, or null.
 *
 * Two codes is not a filing decision — "CVE575_and_MTH101.pdf" belongs to whichever
 * the sender meant, and only the surrounding words can say which.
 */
function codeInName(fileName: string): string | null {
  const codes = parseCourseList(fileName).filter((code) => !NOT_A_COURSE.test(code))
  return codes.length === 1 ? (codes[0] ?? null) : null
}

export const documentService = new DocumentService()
