import { zodResponseFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { DocType, type Message, type Resource } from '../models/index.js'
import { resourceRepository } from '../repositories/index.js'
import { courseKey } from '../utils/courses.js'
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

    const course = tag.course ?? fallbackCourse
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

export const documentService = new DocumentService()
