/**
 * Empties every store Peermate writes to, so a demo starts from nothing.
 *
 * Deliberately does not touch `auth_state/` — that is the live WhatsApp pairing, and
 * deleting it means re-pairing the handset before anything works at all.
 *
 * Run with: npx tsx src/scripts/reset.ts
 */
import { ChromaClient } from 'chromadb'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { closeMongo, connectMongo, getDb } from '../db/mongo.js'
import { connectMinio, getMinio } from '../db/minio.js'

const COLLECTIONS = [
  'users',
  'groups',
  'messages',
  'extractions',
  'resources',
  'notifications',
  'conversations',
  'pending_decisions',
  'schedules',
  'courses',
]

async function clearMongo(): Promise<void> {
  const db = getDb()
  for (const name of COLLECTIONS) {
    const { deletedCount } = await db.collection(name).deleteMany({})
    console.log(`mongo   ${name.padEnd(20)} ${deletedCount}`)
  }
}

/** The stored voice notes, images and documents the message rows pointed at. */
async function clearMinio(): Promise<void> {
  await connectMinio()
  const client = getMinio()
  const keys: string[] = []

  const stream = client.listObjectsV2(config.minio.bucket, '', true)
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (item) => {
      if (item.name) keys.push(item.name)
    })
    stream.on('end', resolve)
    stream.on('error', reject)
  })

  if (keys.length > 0) await client.removeObjects(config.minio.bucket, keys)
  console.log(`minio   ${config.minio.bucket.padEnd(20)} ${keys.length}`)
}

/**
 * Dropped rather than emptied. Leaving the embeddings behind is the failure that
 * looks like a ghost: Mongo is clean, the archive is gone, and Q&A still answers
 * confidently from messages that no longer exist anywhere else.
 */
async function clearChroma(): Promise<void> {
  const url = new URL(config.chroma.url)
  const client = new ChromaClient({
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 8000)),
    ssl: url.protocol === 'https:',
  })

  const before = await client
    .getOrCreateCollection({ name: config.chroma.collection, embeddingFunction: null })
    .then((collection) => collection.count())
    .catch(() => 0)

  await client.deleteCollection({ name: config.chroma.collection }).catch(() => undefined)
  await client.createCollection({
    name: config.chroma.collection,
    configuration: { hnsw: { space: 'cosine' } },
    embeddingFunction: null,
  })
  console.log(`chroma  ${config.chroma.collection.padEnd(20)} ${before}`)
}

async function main(): Promise<void> {
  await connectMongo()
  console.log('\ncleared:')
  await clearMongo()
  await clearMinio()
  await clearChroma()
  await closeMongo()
  console.log('\nauth_state/ untouched — the bot is still paired.\n')
}

main().catch((error) => {
  logger.fatal({ err: error }, 'reset failed')
  process.exit(1)
})
