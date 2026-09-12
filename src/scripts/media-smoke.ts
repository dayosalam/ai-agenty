/**
 * The differentiator, end to end.
 *
 * Runs a real voice note through Whisper and a real timetable image through vision,
 * then extracts from each transcript. These are the two paths that cannot be checked
 * with text fixtures, and the two the demo is built on.
 *
 * Run with: npx tsx src/scripts/media-smoke.ts
 */
import { readFileSync } from 'node:fs'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { connectChroma } from '../db/chroma.js'
import { connectMinio } from '../db/minio.js'
import { closeMongo, connectMongo } from '../db/mongo.js'
import type { Message } from '../models/index.js'
import { extractionService } from '../services/extraction.service.js'
import { transcriptionService } from '../services/transcription.service.js'
import { visionService } from '../services/vision.service.js'

const GROUP = '120363999000000002@g.us'

function msg(over: Partial<Message>): Message {
  return {
    waMessageId: `media-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    chatJid: GROUP,
    senderJid: '2348010000000@s.whatsapp.net',
    senderPhone: '2348010000000',
    senderName: 'Dr. Bello',
    fromGroup: true,
    timestamp: new Date(),
    type: 'text',
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

function section(title: string): void {
  console.log(`\n${'─'.repeat(64)}\n${title}\n${'─'.repeat(64)}`)
}

function show(
  announcements: {
    eventType: string
    date: string | null
    time: string | null
    venue: string | null
    course: string | null
    originalDateText: string | null
  }[],
): void {
  for (const a of announcements) {
    console.log(
      `  • ${a.course ?? '?'} ${a.eventType} — ${a.date ?? 'no date'} ${a.time ?? ''} ${a.venue ?? ''}  (said: "${a.originalDateText ?? '—'}")`.replace(
        /\s+/g,
        ' ',
      ),
    )
  }
}

async function main(): Promise<void> {
  await connectMongo()
  await connectMinio()
  await connectChroma()

  section('1. voice note → Whisper')
  const audio = readFileSync('.local/fixtures/voicenote.m4a')
  console.log(`input: ${(audio.length / 1024).toFixed(0)} KB of audio, nobody played it`)
  const transcript = await transcriptionService.transcribe(audio, 'audio/mp4')
  console.log(`\ntranscript:\n"${transcript}"`)

  const voiceMessage = msg({ type: 'audio', transcript, mimeType: 'audio/ogg' })
  const voiceResult = await extractionService.classify(voiceMessage, { defaultCourse: 'CSC 301' })
  console.log(`\nkind: ${voiceResult.kind}, announcements: ${voiceResult.announcements.length}`)
  show(voiceResult.announcements)

  section('2. photographed timetable → vision OCR')
  const image = readFileSync('.local/fixtures/timetable.png')
  console.log(`input: ${(image.length / 1024).toFixed(0)} KB image`)
  const ocr = await visionService.readImage(image, 'image/png')
  console.log(`\nOCR:\n${ocr}`)

  const imageMessage = msg({ type: 'image', transcript: ocr, mimeType: 'image/png' })
  const imageResult = await extractionService.classify(imageMessage, { defaultCourse: 'CSC 301' })
  console.log(`\nkind: ${imageResult.kind}, announcements: ${imageResult.announcements.length}`)
  show(imageResult.announcements)

  section('3. one image, several announcements')
  console.log(
    imageResult.announcements.length >= 2
      ? `✅ ${imageResult.announcements.length} events from a single photo — this is PRD §6 item 12`
      : `❌ expected several events from the timetable, got ${imageResult.announcements.length}`,
  )

  section('4. a voice note with no announcement stays out')
  const chatter = msg({
    type: 'audio',
    transcript: 'Hello everybody, hope you are enjoying the weekend. See you around.',
  })
  const chatterResult = await extractionService.classify(chatter, { defaultCourse: 'CSC 301' })
  console.log(
    chatterResult.kind === 'noise'
      ? '✅ classified as noise, no phantom announcement'
      : `❌ leaked through as ${chatterResult.kind}`,
  )

  await closeMongo()
  console.log(`\n✅ media smoke complete (timezone ${config.digest.timezone})\n`)
}

main().catch((error) => {
  logger.fatal({ err: error }, 'media smoke failed')
  process.exit(1)
})
