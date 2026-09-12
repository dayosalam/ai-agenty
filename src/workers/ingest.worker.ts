import { downloadMediaMessage, type WAMessage } from '@whiskeysockets/baileys'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { getMedia, putMedia } from '../db/minio.js'
import type { Message, ProcessingStatus } from '../models/index.js'
import { groupRepository, messageRepository, extractionRepository } from '../repositories/index.js'
import { announcementService } from '../services/announcement.service.js'
import { documentService } from '../services/document.service.js'
import { resourceAlertService } from '../services/resource-alert.service.js'
import { documentReader } from '../services/document-reader.service.js'
import { groupService } from '../services/group.service.js'
import { dmService } from '../services/dm.service.js'
import { extractionService } from '../services/extraction.service.js'
import { indexingService } from '../services/indexing.service.js'
import { transcriptionService } from '../services/transcription.service.js'
import { visionService } from '../services/vision.service.js'
import { authorityOf } from '../utils/authority.js'
import { normalize } from '../whatsapp/normalizer.js'
import { getSocket } from '../whatsapp/socket.js'
import { Queue } from './queue.js'

const MEDIA_TYPES = new Set<Message['type']>(['image', 'audio', 'document', 'video'])

async function handle(raw: WAMessage): Promise<void> {
  const message = normalize(raw)
  if (!message) return

  // Being in a group is not permission to read it. Nothing from an unapproved group
  // is stored — not the text, not the media, not even the fact it was sent. PRD §7.
  if (message.fromGroup && !(await isApproved(message.chatJid))) {
    logger.debug({ chatJid: message.chatJid }, 'group not approved, discarding')
    return
  }

  // Dedupe before any paid work. A re-delivered message must not be re-transcribed,
  // re-extracted, or re-notified.
  if (!(await messageRepository.insertIfNew(message))) {
    logger.debug({ waMessageId: message.waMessageId }, 'already ingested, skipping')
    return
  }

  const log = logger.child({ waMessageId: message.waMessageId, type: message.type })

  try {
    if (MEDIA_TYPES.has(message.type)) {
      message.mediaKey = await storeMedia(raw, message)
    }

    // Read media on both paths. A student photographs their timetable or records a
    // question just as readily in a DM as in a group, and a DM that only saw the
    // caption was answering a question it could not see.
    await readMedia(message, log)

    // A DM is a student talking to Peermate; a group message is source material.
    // They share ingestion and provenance but nothing after it.
    if (!message.fromGroup) {
      await dmService.handle(message)
      await messageRepository.setStatus(message.waMessageId, 'done')
      return
    }
    // understand() decides the terminal status: a sticker or empty media is
    // 'skipped', not 'done', and overwriting that would lose which messages were
    // never indexed.
    const status = await understand(message, log)
    await messageRepository.setStatus(message.waMessageId, status)
  } catch (error) {
    // Fail soft. A message that cannot be transcribed is still a stored message,
    // and the digest still goes out.
    log.error({ err: error }, 'ingest failed')
    await messageRepository.setStatus(message.waMessageId, 'failed', String(error))
  }
}

/** Turns audio and images into text. The transcript is what everything downstream reads. */
async function readMedia(message: Message, log: typeof logger): Promise<void> {
  if (!message.mediaKey) return
  if (message.type !== 'audio' && message.type !== 'image') return

  const bytes = await getMedia(message.mediaKey)
  const transcript =
    message.type === 'audio'
      ? await transcriptionService.transcribe(bytes, message.mimeType)
      : await visionService.readImage(bytes, message.mimeType)

  if (!transcript) return
  message.transcript = transcript
  await messageRepository.setTranscript(message.waMessageId, transcript)
  log.info({ chars: transcript.length }, message.type === 'audio' ? 'transcribed' : 'image read')
}

/** Embed for retrieval, then classify and extract. Returns the terminal status. */
async function understand(message: Message, log: typeof logger): Promise<ProcessingStatus> {
  // Approval was checked before anything was stored, so the group exists by now.
  const group = await groupRepository.findByJid(message.chatJid)
  const defaultCourse = group?.defaultCourse ?? null

  const preceding = await precedingContext(message)

  // A document is filed first — that half never depended on being able to read it.
  if (message.type === 'document') {
    const resource = await documentService.file(message, preceding, defaultCourse)
    await readDocument(message, resource?.courseKey ?? group?.defaultCourseKey ?? null, log)
    // Batched, so a five-file upload is one heads-up rather than five.
    if (resource) resourceAlertService.queue(resource, message.senderName)
  }

  const content = [message.text, message.caption, message.transcript]
    .filter(Boolean)
    .join('\n\n')
    .trim()

  if (!content && message.type !== 'document') {
    // Stickers and empty media are retained but not embedded — nothing to search on.
    return 'skipped'
  }

  const quoted = await quotedContext(message)
  const authority = authorityOf(message, group)
  const result = await extractionService.classify(message, {
    defaultCourse,
    quotedText: quoted,
    precedingTexts: message.type === 'document' ? preceding : [],
  })
  const rows = extractionService.toRows(message, result, defaultCourse, authority)

  if (content) {
    // Every course the message mentions, so a student searching their own course
    // finds a timetable that also covered three others.
    const courses = rows.map((row) => row.courseKey).filter(Boolean)
    await indexingService.index(
      message,
      content,
      courses.length > 0 ? courses : [group?.defaultCourseKey ?? null],
    )
  }

  if (rows.length === 0) {
    log.debug({ kind: result.kind }, 'no announcement')
    return 'done'
  }

  await extractionRepository.insertMany(rows)
  log.info({ count: rows.length }, 'announcements extracted')
  await announcementService.notify(rows, message)
  return 'done'
}

/**
 * Reads a shared document into the retrieval store so questions can be answered from
 * its contents, not just from what people typed about it.
 *
 * Strictly additive: the file is filed before this runs, so a scan that cannot be
 * read, a corrupt file, or an unsupported format loses nothing — it is still stored
 * and still sendable. When it cannot be read, it is indexed as such, so a student
 * asking about it is told the truth rather than told it does not exist.
 */
async function readDocument(
  message: Message,
  courseKey: string | null,
  log: typeof logger,
): Promise<void> {
  if (!message.mediaKey) return

  const fileName = message.fileName ?? message.waMessageId
  if (!documentReader.supports(message.mimeType)) {
    await indexingService.indexUnreadable(message, courseKey, fileName, 'unsupported file type')
    return
  }

  const bytes = await getMedia(message.mediaKey)
  const read = await documentReader.read(bytes, message.mimeType, fileName)

  if (!read) {
    await indexingService.indexUnreadable(
      message,
      courseKey,
      fileName,
      'it appears to be a scan with no readable text',
    )
    return
  }

  const chunks = documentReader.chunk(read.text, read.pages)
  await indexingService.indexDocument(message, chunks, courseKey, fileName, read.readVia)
  log.info({ pages: read.pages, chunks: chunks.length, readVia: read.readVia }, 'document indexed')
}

/** "No, it is LG8" carries its subject only in the message it replies to. */
async function quotedContext(message: Message): Promise<string | null> {
  if (!message.quotedMessageId) return null
  const quoted = await messageRepository.findById(message.quotedMessageId)
  return quoted?.text ?? quoted?.transcript ?? quoted?.caption ?? null
}

/** A bounded window, used only to tag a document whose filename says nothing. */
async function precedingContext(message: Message): Promise<string[]> {
  if (message.type !== 'document') return []
  const previous = await messageRepository.precedingText(message.chatJid, message.timestamp, 3)
  return previous
    .map((item) => item.text ?? '')
    .filter(Boolean)
    .reverse()
}

async function storeMedia(raw: WAMessage, message: Message): Promise<string> {
  const buffer = (await downloadMediaMessage(
    raw,
    'buffer',
    {},
    {
      logger: logger.child({ module: 'baileys' }),
      reuploadRequest: getSocket().updateMediaMessage,
    },
  )) as Buffer

  const key = `${message.type}/${message.waMessageId}`
  await putMedia(key, buffer, message.mimeType)
  await messageRepository.setMediaKey(message.waMessageId, key)
  await messageRepository.setStatus(message.waMessageId, 'processing')
  return key
}

/**
 * A group the operator has not approved is read by nobody. Registration happens on
 * the join event, so an unknown group here means we joined before this gate existed
 * — treat it as pending and ask, rather than reading it by default.
 */
async function isApproved(chatJid: string): Promise<boolean> {
  const group = await groupRepository.findByJid(chatJid)
  if (!group) {
    await groupService.register(chatJid, { subject: null })
    return false
  }
  return group.status === 'approved'
}

export const ingestQueue = new Queue<WAMessage>(handle, config.ingest.concurrency, 'ingest')

/**
 * Finishes what a restart interrupted.
 *
 * The queue is deliberately not durable — WhatsApp re-delivers on reconnect and the
 * unique index makes that harmless. But a message already inserted will never be
 * re-delivered, so anything caught mid-pipeline by a restart would stay unprocessed
 * for ever. Media is re-read from MinIO, so no WhatsApp socket is needed.
 */
/** Max automatic attempts before a message needs a deliberate *retry failed*. */
const MAX_AUTO_ATTEMPTS = 3

export async function recoverUnfinished(): Promise<void> {
  await reprocess(await messageRepository.unfinished(), 'interrupted by a restart')

  // Most failures are transient — a Whisper timeout, a rate limit, a MinIO blip —
  // and the announcement is lost for good if nobody retries. Capped, so a genuinely
  // broken message is attempted a few times and then left for the operator.
  await reprocess(
    await messageRepository.failed(50, MAX_AUTO_ATTEMPTS),
    'failed earlier, retrying automatically',
  )

  const exhausted = await messageRepository.failed(50)
  const stuck = exhausted.filter((m) => (m.processingAttempts ?? 0) >= MAX_AUTO_ATTEMPTS)
  if (stuck.length > 0) {
    logger.warn(
      { count: stuck.length },
      'messages failed too many times to retry automatically — use "retry failed"',
    )
  }
}

/**
 * Re-runs messages whose pipeline threw. Exposed to the operator as *retry failed*,
 * because a transient Whisper or network error would otherwise lose the announcement
 * permanently — the stored record blocks WhatsApp's own re-delivery.
 */
export async function retryFailed(): Promise<number> {
  // No cap here: the operator is asking on purpose, usually having just fixed
  // whatever was breaking it.
  const failed = await messageRepository.failed()
  await reprocess(failed, 'previously failed')
  return failed.length
}

async function reprocess(messages: Message[], why: string): Promise<void> {
  if (messages.length === 0) return
  logger.info({ count: messages.length, why }, 'reprocessing messages')

  for (const message of messages) {
    const log = logger.child({ waMessageId: message.waMessageId, recovered: true })
    try {
      // Clear a stale transcript so a half-finished read is not treated as done.
      await readMedia(message, log)
      await messageRepository.setStatus(message.waMessageId, await understand(message, log))
    } catch (error) {
      log.error({ err: error }, 'reprocessing failed')
      await messageRepository.setStatus(message.waMessageId, 'failed', String(error))
    }
  }
}
