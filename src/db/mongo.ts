import { MongoClient, type Db } from 'mongodb'
import { config } from '../config.js'
import { logger } from '../core/logger.js'

let client: MongoClient | null = null
let db: Db | null = null

export async function connectMongo(): Promise<Db> {
  if (db) return db
  client = new MongoClient(config.mongo.url)
  await client.connect()
  db = client.db(config.mongo.database)
  await ensureIndexes(db)
  logger.info({ database: config.mongo.database }, 'mongo connected')
  return db
}

export function getDb(): Db {
  if (!db) throw new Error('Mongo not connected — call connectMongo() during startup')
  return db
}

export async function closeMongo(): Promise<void> {
  await client?.close()
  client = null
  db = null
}

async function ensureIndexes(database: Db): Promise<void> {
  // The idempotency guard. WhatsApp re-delivers messages when a dropped socket
  // reconnects; without this a reconnect would re-run extraction and re-send every
  // notification. See PRD §8.
  await database.collection('messages').createIndex({ waMessageId: 1 }, { unique: true })
  await database.collection('messages').createIndex({ chatJid: 1, timestamp: -1 })
  await database.collection('messages').createIndex({ processingStatus: 1 })

  await database.collection('extractions').createIndex({ courseKey: 1, date: 1 })
  await database.collection('extractions').createIndex({ sourceMessageId: 1 })

  await database.collection('users').createIndex({ phone: 1 }, { unique: true })
  await database.collection('users').createIndex({ courseKeys: 1 })
  await database.collection('users').createIndex({ onboardingState: 1, digestHour: 1 })

  await database.collection('groups').createIndex({ chatJid: 1 }, { unique: true })
  await database.collection('groups').createIndex({ status: 1 })

  await database.collection('resources').createIndex({ courseKey: 1, postedAt: -1 })

  await database.collection('notifications').createIndex({ userPhone: 1, sentAt: -1 })

  await database.collection('pending_decisions').createIndex({ eventId: 1 }, { unique: true })
  await database.collection('pending_decisions').createIndex({ status: 1, askedAt: 1 })

  await database.collection('schedules').createIndex({ phone: 1, kind: 1 })
  await database.collection('schedules').createIndex({ phone: 1, courseKey: 1 })

  await database.collection('courses').createIndex({ courseKey: 1 }, { unique: true })

  await database.collection('conversations').createIndex({ phone: 1 }, { unique: true })
  await ensureConversationTtl(database)
}

/** A month. The referents inside expire in 45 minutes; the transcript is the reason. */
const CONVERSATION_TTL_SECONDS = 60 * 60 * 24 * 30

/**
 * The whole document goes when it expires, transcript included — so this bounds how
 * far back "you told me last week" can reach, not just how long a pronoun lives.
 *
 * Mongo refuses a createIndex that changes an existing index's options, and the six
 * hour version of this index is already out there deleting threads overnight. collMod
 * is the only way to widen one in place.
 */
async function ensureConversationTtl(database: Db): Promise<void> {
  try {
    await database
      .collection('conversations')
      .createIndex({ updatedAt: 1 }, { expireAfterSeconds: CONVERSATION_TTL_SECONDS })
  } catch {
    await database.command({
      collMod: 'conversations',
      index: { keyPattern: { updatedAt: 1 }, expireAfterSeconds: CONVERSATION_TTL_SECONDS },
    })
    logger.info({ seconds: CONVERSATION_TTL_SECONDS }, 'conversation ttl widened')
  }
}
