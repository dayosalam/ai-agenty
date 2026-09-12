/**
 * Document reading, end to end: a text PDF, a scanned PDF, a .docx, and an
 * unreadable file — then real questions answered from their contents.
 *
 * Run with: npx tsx src/scripts/doc-smoke.ts
 */
import { readFileSync } from 'node:fs'
import { logger } from '../core/logger.js'
import { getCollection, connectChroma } from '../db/chroma.js'
import { connectMinio, putMedia } from '../db/minio.js'
import { closeMongo, connectMongo } from '../db/mongo.js'
import type { Message } from '../models/index.js'
import { messageRepository } from '../repositories/index.js'
import { documentReader, DOCX_MIME, PDF_MIME } from '../services/document-reader.service.js'
import { indexingService } from '../services/indexing.service.js'
import { qaService } from '../services/qa.service.js'

const GROUP = '120363999000000003@g.us'
const COURSE = 'CSC301'

function msg(over: Partial<Message>): Message {
  return {
    waMessageId: `doc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    chatJid: GROUP,
    senderJid: '2348010000000@s.whatsapp.net',
    senderPhone: '2348010000000',
    senderName: 'Dr. Bello',
    fromGroup: true,
    timestamp: new Date(),
    type: 'document',
    text: null,
    caption: null,
    quotedMessageId: null,
    mediaKey: null,
    mimeType: null,
    fileName: null,
    transcript: null,
    processingStatus: 'pending',
    processingError: null,
    processingAttempts: 0,
    ingestedAt: new Date(),
    ...over,
  } as Message
}

function section(t: string): void {
  console.log(`\n${'─'.repeat(64)}\n${t}\n${'─'.repeat(64)}`)
}

async function main(): Promise<void> {
  await connectMongo()
  await connectMinio()
  await connectChroma()

  await getCollection().delete({ where: { chatJid: { $eq: GROUP } } })

  const cases: [string, string, string, string][] = [
    ['CSC301_wk3_slides.pdf', PDF_MIME, 'PDF with a text layer', COURSE],
    ['scanned_notice.pdf', PDF_MIME, 'scanned PDF (no text layer)', COURSE],
    ['STA202_assignment2.docx', DOCX_MIME, 'Word document', 'STA202'],
  ]

  for (const [file, mime, label, courseKey] of cases) {
    section(`${label} — ${file}`)
    const bytes = readFileSync(`.local/fixtures/${file}`)
    const key = `document/doc-smoke-${file}`
    await putMedia(key, bytes, mime)

    const message = msg({ fileName: file, mimeType: mime, mediaKey: key })
    await messageRepository.insertIfNew(message)

    const read = await documentReader.read(bytes, mime, file)
    if (!read) {
      await indexingService.indexUnreadable(message, courseKey, file, 'no readable text')
      console.log('→ UNREADABLE — indexed so students are told, not left in silence')
      continue
    }
    const chunks = documentReader.chunk(read.text, read.pages)
    await indexingService.indexDocument(message, chunks, courseKey, file, read.readVia)
    console.log(
      `→ readVia=${read.readVia} pages=${read.pages} chars=${read.text.length} chunks=${chunks.length}`,
    )
  }

  section('unsupported file type (a .zip nobody can read)')
  const zipKey = 'document/doc-smoke-notes.zip'
  await putMedia(zipKey, Buffer.from('PK\x03\x04 not really a zip'), 'application/zip')
  const zipMessage = msg({
    fileName: 'CSC301_notes.zip',
    mimeType: 'application/zip',
    mediaKey: zipKey,
  })
  await messageRepository.insertIfNew(zipMessage)
  await indexingService.indexUnreadable(
    zipMessage,
    COURSE,
    'CSC301_notes.zip',
    'unsupported file type',
  )
  console.log('→ indexed as unreadable')

  section('questions answered from document contents')
  const questions: [string, string[]][] = [
    ['what does BCNF require?', [COURSE]],
    ['what is on the week 3 quiz and what is it worth?', [COURSE]],
    ['what are the questions in the STA 202 assignment?', ['STA202']],
    ['what does the revision timetable say about Tuesday?', [COURSE]],
    ['what is in the CSC 301 notes zip file?', [COURSE]],
  ]
  for (const [question, courses] of questions) {
    console.log(`\nQ: ${question}\nA: ${await qaService.answer(question, courses)}`)
  }

  await closeMongo()
  console.log('\n✅ document smoke complete\n')
}

main().catch((e) => {
  logger.fatal({ err: e }, 'doc smoke failed')
  process.exit(1)
})
