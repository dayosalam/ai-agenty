import { ChromaClient, type Collection } from 'chromadb'
import { config } from '../config.js'
import { logger } from '../core/logger.js'

let collection: Collection | null = null

/**
 * The JS Chroma client speaks HTTP only — there is no embedded mode as in Python,
 * so a Chroma server must be running. It also pins an API version: a v1-era client
 * gets HTTP 410 from a modern server, so the client major must track the server.
 *
 * embeddingFunction is null on purpose. EmbeddingService computes vectors and passes
 * them in explicitly, which keeps the model a Peermate decision rather than Chroma's.
 */
export async function connectChroma(): Promise<Collection> {
  if (collection) return collection
  const url = new URL(config.chroma.url)
  const client = new ChromaClient({
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 8000)),
    ssl: url.protocol === 'https:',
  })
  collection = await client.getOrCreateCollection({
    name: config.chroma.collection,
    configuration: { hnsw: { space: 'cosine' } },
    embeddingFunction: null,
  })
  logger.info({ collection: config.chroma.collection }, 'chroma connected')
  return collection
}

export function getCollection(): Collection {
  if (!collection) throw new Error('Chroma not connected — call connectChroma() during startup')
  return collection
}
