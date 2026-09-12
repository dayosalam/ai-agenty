import { config } from '../config.js'
import { getCollection } from '../db/chroma.js'
import { embeddingService } from './embedding.service.js'

export interface Candidate {
  waMessageId: string
  content: string
  senderName: string
  type: string
  timestamp: Date
  courseKey: string
  /** 'document' for a chunk of a shared PDF, 'message' for something someone typed or said. */
  sourceKind: string
  fileName: string | null
  page: number | null
  /** 'text' from a text layer, 'ocr' from a scan, 'none' when it could not be read. */
  readVia: string
}

/**
 * Retrieval favours recall. Read-time conflict resolution can only compare records
 * that retrieval actually returned, so filter by the student's courses and a recent
 * window, then take a generous k and hand the LLM the whole candidate set.
 */
export class RetrievalService {
  /**
   * Everything readable that was ever shared as a file for one course.
   *
   * Fetched by metadata rather than by similarity: preparing for a test means
   * covering the material, and a search for "what is on the test" returns the corner
   * of it that happens to phrase itself that way. Unreadable placeholders are
   * returned too — a file Peermate cannot open is still worth admitting to.
   */
  async material(courseKey: string, limit = 150): Promise<Candidate[]> {
    const result = await getCollection().get({
      where: { $and: [{ courseKey: { $eq: courseKey } }, { sourceKind: { $eq: 'document' } }] },
      limit,
    })

    const documents = result.documents ?? []
    const metadatas = result.metadatas ?? []

    return documents.flatMap((content, index) => {
      const meta = metadatas[index]
      if (!content || !meta) return []
      return [
        {
          waMessageId: String(meta['waMessageId'] ?? ''),
          content,
          senderName: String(meta['senderName'] ?? 'unknown'),
          type: String(meta['type'] ?? 'document'),
          timestamp: new Date(Number(meta['timestampMs'] ?? 0)),
          courseKey: String(meta['courseKey'] ?? ''),
          sourceKind: 'document',
          fileName: meta['fileName'] ? String(meta['fileName']) : null,
          page: meta['page'] ? Number(meta['page']) : null,
          readVia: String(meta['readVia'] ?? 'text'),
        },
      ]
    })
  }

  async search(
    question: string,
    courseKeys: string[],
    k = config.retrieval.candidateK,
  ): Promise<Candidate[]> {
    if (courseKeys.length === 0) return []

    const since = Date.now() - config.retrieval.windowDays * 24 * 60 * 60 * 1000
    const embedding = await embeddingService.embed(question)

    const result = await getCollection().query({
      queryEmbeddings: [embedding],
      nResults: k,
      where: {
        $and: [{ courseKey: { $in: courseKeys } }, { timestampMs: { $gte: since } }],
      },
    })

    const documents = result.documents[0] ?? []
    const metadatas = result.metadatas[0] ?? []

    return documents.flatMap((content, index) => {
      const meta = metadatas[index]
      if (!content || !meta) return []
      return [
        {
          waMessageId: String(meta['waMessageId'] ?? ''),
          content,
          senderName: String(meta['senderName'] ?? 'unknown'),
          type: String(meta['type'] ?? 'text'),
          timestamp: new Date(Number(meta['timestampMs'] ?? 0)),
          courseKey: String(meta['courseKey'] ?? ''),
          sourceKind: String(meta['sourceKind'] ?? 'message'),
          fileName: meta['fileName'] ? String(meta['fileName']) : null,
          page: meta['page'] ? Number(meta['page']) : null,
          readVia: String(meta['readVia'] ?? 'text'),
        },
      ]
    })
  }
}

export const retrievalService = new RetrievalService()
