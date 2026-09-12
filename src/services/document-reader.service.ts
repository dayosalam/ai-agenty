import mammoth from 'mammoth'
import { extractText, getDocumentProxy } from 'unpdf'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { getOpenAI } from './openai.client.js'

/** Below this, a "PDF" is almost certainly a scan with no text layer. */
const MIN_USEFUL_CHARS = 40

/** Big enough to hold a whole answer, small enough that a citation stays precise. */
const CHUNK_CHARS = 1200
const CHUNK_OVERLAP = 150

/** Sending a very large scan to the model page-by-page is not worth the spend. */
const MAX_OCR_BYTES = 8 * 1024 * 1024

export const PDF_MIME = 'application/pdf'
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const DOC_MIME = 'application/msword'

/** How the text was obtained. Students are told when it came from a scan. */
export type ReadVia = 'text' | 'ocr' | 'none'

export interface DocumentText {
  text: string
  pages: number
  readVia: ReadVia
}

export interface DocumentChunk {
  text: string
  page: number
  index: number
}

const OCR_PROMPT = `This file was shared in a university course group chat and a student who cannot open it needs to know what it says.

Write out its contents as plain text. Keep headings, course codes, dates, times, venues and question numbers exactly as they appear, and keep the original order. Report only what is actually visible — do not summarise or add anything. If nothing is legible, reply with exactly: NO TEXT`

const REFUSAL = /\b(I'?m sorry|I can'?t|I cannot|I am unable|unable to)\b/i

/**
 * Reads the contents of shared documents.
 *
 * This reverses the PRD's original "tag, don't read" scope: students ask questions
 * whose answers are inside the slides, not in anything anyone typed in the chat.
 * Tagging still happens first and independently, so reading is strictly additive —
 * a file that cannot be read is still filed, still stored, and still sent back.
 */
export class DocumentReaderService {
  supports(mimeType: string | null): boolean {
    return mimeType === PDF_MIME || mimeType === DOCX_MIME || mimeType === DOC_MIME
  }

  async read(
    bytes: Buffer,
    mimeType: string | null,
    fileName: string,
  ): Promise<DocumentText | null> {
    if (mimeType === DOCX_MIME || mimeType === DOC_MIME) return this.readDocx(bytes)
    if (mimeType === PDF_MIME) return this.readPdf(bytes, fileName)
    return null
  }

  private async readDocx(bytes: Buffer): Promise<DocumentText | null> {
    try {
      const { value } = await mammoth.extractRawText({ buffer: bytes })
      const text = value.replace(/[ \t]+/g, ' ').trim()
      if (text.length < MIN_USEFUL_CHARS) return null
      // .docx has no page concept until it is laid out; approximate for citations.
      const pages = Math.max(1, Math.ceil(text.length / 2500))
      logger.info({ chars: text.length }, 'docx read')
      return { text, pages, readVia: 'text' }
    } catch (error) {
      // .doc (the pre-2007 binary format) is not a zip and will land here.
      logger.warn({ err: error }, 'could not read docx text')
      return null
    }
  }

  private async readPdf(bytes: Buffer, fileName: string): Promise<DocumentText | null> {
    try {
      const document = await getDocumentProxy(new Uint8Array(bytes))
      const { text, totalPages } = await extractText(document, { mergePages: false })
      const pages = Array.isArray(text) ? text : [text]
      const joined = pages
        .join('\n\n')
        .replace(/[ \t]+/g, ' ')
        .trim()

      if (joined.length >= MIN_USEFUL_CHARS) {
        logger.info({ chars: joined.length, pages: totalPages }, 'pdf read from text layer')
        return { text: joined, pages: totalPages, readVia: 'text' }
      }

      // No text layer: a photographed handout in a PDF wrapper. Extract what we can.
      logger.info({ fileName, pages: totalPages }, 'pdf has no text layer, trying OCR')
      return this.ocrPdf(bytes, fileName, totalPages)
    } catch (error) {
      logger.warn({ err: error, fileName }, 'could not read pdf')
      return null
    }
  }

  /** Scanned pages, read by the vision model rather than parsed. */
  private async ocrPdf(
    bytes: Buffer,
    fileName: string,
    pages: number,
  ): Promise<DocumentText | null> {
    if (bytes.length > MAX_OCR_BYTES) {
      logger.warn({ fileName, bytes: bytes.length }, 'scan too large to OCR, filing untagged')
      return null
    }

    try {
      const completion = await getOpenAI().chat.completions.create({
        model: config.openai.visionModel,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                file: {
                  filename: fileName,
                  file_data: `data:${PDF_MIME};base64,${bytes.toString('base64')}`,
                },
              },
              { type: 'text', text: OCR_PROMPT },
            ],
          },
        ],
      })

      const text = completion.choices[0]?.message.content?.trim() ?? ''
      if (!text || text === 'NO TEXT' || REFUSAL.test(text) || text.length < MIN_USEFUL_CHARS) {
        logger.info({ fileName }, 'scan could not be read')
        return null
      }

      logger.info({ fileName, chars: text.length }, 'scanned pdf read by OCR')
      return { text, pages, readVia: 'ocr' }
    } catch (error) {
      logger.warn({ err: error, fileName }, 'ocr failed')
      return null
    }
  }

  /**
   * Splits into overlapping chunks, each carrying its page.
   *
   * The PRD's "one document per message, never chunked across messages" rule is
   * about never blending two people's messages into one embedding. Chunking *within*
   * a single file does not break it: every chunk still cites the one message that
   * delivered it.
   */
  chunk(text: string, pages: number): DocumentChunk[] {
    const chunks: DocumentChunk[] = []
    const perPage = Math.max(1, Math.ceil(text.length / Math.max(1, pages)))

    let start = 0
    let index = 0
    while (start < text.length) {
      const end = Math.min(start + CHUNK_CHARS, text.length)
      const slice = text.slice(start, end).trim()
      if (slice.length > 0) {
        chunks.push({ text: slice, page: Math.floor(start / perPage) + 1, index })
        index += 1
      }
      if (end === text.length) break
      start = end - CHUNK_OVERLAP
    }
    return chunks
  }
}

export const documentReader = new DocumentReaderService()
