import { getCollection } from '../db/chroma.js'
import { logger } from '../core/logger.js'
import type { Message } from '../models/index.js'
import { embeddingService } from './embedding.service.js'
import type { DocumentChunk, ReadVia } from './document-reader.service.js'

export const NO_COURSE = 'NONE'

/**
 * One Chroma document per message — never chunked across messages. A citation
 * therefore points at a real message someone actually sent, not at a fragment
 * assembled from several.
 */
export class IndexingService {
  /**
   * Indexed once per course it mentions.
   *
   * A photographed timetable carries CSC 301, STA 202 and MTH 101 at once. Filed
   * under only the first, a student taking the third would search their own course
   * and never find the message that named it. One embedding, several filed copies.
   */
  async index(message: Message, content: string, courseKeys: (string | null)[]): Promise<void> {
    const keys = [...new Set(courseKeys.map((key) => key ?? NO_COURSE))]
    const embedding = await embeddingService.embed(content)

    await getCollection().add({
      ids: keys.map((key) => `${message.waMessageId}:${key}`),
      embeddings: keys.map(() => embedding),
      documents: keys.map(() => content),
      metadatas: keys.map((key) => this.metadata(message, key === NO_COURSE ? null : key)),
    })
    logger.debug({ waMessageId: message.waMessageId, courses: keys }, 'indexed')
  }

  /**
   * Chunks of one PDF, all citing the single message that delivered it.
   *
   * Chunking inside one document does not break the never-chunk-across-messages
   * rule: no chunk ever blends two senders.
   */
  async indexDocument(
    message: Message,
    chunks: DocumentChunk[],
    courseKey: string | null,
    fileName: string,
    readVia: ReadVia = 'text',
  ): Promise<void> {
    if (chunks.length === 0) return

    const embeddings = await embeddingService.embedAll(chunks.map((chunk) => chunk.text))
    await getCollection().add({
      ids: chunks.map((chunk) => `${message.waMessageId}#${chunk.index}`),
      embeddings,
      documents: chunks.map((chunk) => chunk.text),
      metadatas: chunks.map((chunk) => ({
        ...this.metadata(message, courseKey),
        sourceKind: 'document',
        fileName,
        page: chunk.page,
        readVia,
      })),
    })
    logger.info(
      { waMessageId: message.waMessageId, chunks: chunks.length, fileName },
      'pdf indexed',
    )
  }

  /**
   * A file we could not read still gets one searchable entry.
   *
   * Without it, asking about a scanned past-paper returns nothing and Peermate says
   * it has never heard of the file — when in fact it is holding it and can send it.
   * This turns silence into an honest answer.
   */
  async indexUnreadable(
    message: Message,
    courseKey: string | null,
    fileName: string,
    reason: string,
  ): Promise<void> {
    const note = `Shared file: ${fileName}. Peermate is holding this file and can send it on request, but could not read its contents (${reason}). Any question about what is inside it cannot be answered from the text — the student should ask for the file itself.`
    const embedding = await embeddingService.embed(`${fileName} ${note}`)
    await getCollection().add({
      ids: [`${message.waMessageId}#unreadable`],
      embeddings: [embedding],
      documents: [note],
      metadatas: [
        {
          ...this.metadata(message, courseKey),
          sourceKind: 'document',
          fileName,
          page: 0,
          readVia: 'none',
        },
      ],
    })
    logger.info({ fileName, reason }, 'file indexed as unreadable')
  }

  private metadata(message: Message, courseKey: string | null): Record<string, string | number> {
    return {
      waMessageId: message.waMessageId,
      chatJid: message.chatJid,
      courseKey: courseKey ?? NO_COURSE,
      senderName: message.senderName ?? 'unknown',
      type: message.type,
      sourceKind: 'message',
      // Chroma metadata is scalar-only, and a range filter needs a number.
      timestampMs: message.timestamp.getTime(),
    }
  }
}

export const indexingService = new IndexingService()
