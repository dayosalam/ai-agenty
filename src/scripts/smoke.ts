/**
 * End-to-end check of everything that does not need WhatsApp.
 *
 * Drives real OpenAI calls and real Mongo/Chroma/MinIO writes, then prints what a
 * student would actually receive. Outbound sends are stubbed, so nothing leaves the
 * machine and no socket is required.
 *
 * Run with: npx tsx src/scripts/smoke.ts
 */
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { connectChroma } from '../db/chroma.js'
import { connectMinio, putMedia } from '../db/minio.js'
import { getCollection } from '../db/chroma.js'
import { closeMongo, connectMongo, getDb } from '../db/mongo.js'
import type { Message } from '../models/index.js'
import {
  extractionRepository,
  groupRepository,
  messageRepository,
  userRepository,
} from '../repositories/index.js'
import { deadlineService } from '../services/deadline.service.js'
import { digestService } from '../services/digest.service.js'
import { documentService } from '../services/document.service.js'
import { extractionService } from '../services/extraction.service.js'
import { indexingService } from '../services/indexing.service.js'
import { notifierService } from '../services/notifier.service.js'
import { qaService } from '../services/qa.service.js'
import { resourceService } from '../services/resource.service.js'
import { todayIso, zonedDay } from '../utils/dates.js'

const GROUP = '120363999000000001@g.us'
const STUDENT_PHONE = '2348011112222'
const STUDENT_JID = `${STUDENT_PHONE}@s.whatsapp.net`

/** Captures outbound instead of sending it, so the run needs no WhatsApp socket. */
const outbox: string[] = []
notifierService.sendText = async (jid, text) => {
  outbox.push(`→ ${jid}\n${text}`)
}
notifierService.sendFile = async (jid, _key, fileName) => {
  outbox.push(`→ ${jid}  [file: ${fileName}]`)
}

function msg(over: Partial<Message> & Pick<Message, 'waMessageId' | 'senderName'>): Message {
  return {
    chatJid: GROUP,
    senderJid: '2348010000000@s.whatsapp.net',
    senderPhone: '2348010000000',
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

async function main(): Promise<void> {
  await connectMongo()
  await connectMinio()
  await connectChroma()

  const run = Date.now()
  const tz = config.digest.timezone
  const today = todayIso(tz)
  // Pick a weekday name that is genuinely in the future, so "this X" has one answer.
  const inThreeDays = zonedDay(new Date(Date.now() + 3 * 86_400_000), tz)
  const inThreeDaysName = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'long',
  }).format(new Date(Date.now() + 3 * 86_400_000))

  // Clean slate for this run only.
  await getDb().collection('resources').deleteMany({ courseKey: 'CSC301' })
  await getDb()
    .collection('extractions')
    .deleteMany({ courseKey: { $in: ['CSC301', 'STA202'] } })
  await getCollection().delete({ where: { courseKey: { $in: ['CSC301', 'STA202'] } } })

  section('1. group registers itself from its subject')
  await groupRepository.upsert({
    chatJid: GROUP,
    name: 'CSC 301 — 2025/26 Class',
    defaultCourse: 'CSC 301',
    defaultCourseKey: 'CSC301',
    status: 'approved',
    addedBy: null,
    addedByName: null,
    participantCount: null,
    trustedSenders: [],
    proposedCourse: null,
    proposedBy: null,
    joinedAt: new Date(),
    approvedAt: new Date(),
  })
  const group = await groupRepository.findByJid(GROUP)
  console.log(
    `"${group?.name}" → defaultCourse ${group?.defaultCourse} (key ${group?.defaultCourseKey})`,
  )

  section('2. classification + date resolution')
  const fixtures: Message[] = [
    msg({
      waMessageId: `s${run}-a`,
      senderName: 'Dr. Bello',
      text: `Good morning all. CSC 301 test is this ${inThreeDaysName} 10am in LG7. Bring your ID cards.`,
    }),
    msg({ waMessageId: `s${run}-b`, senderName: 'Chidi', text: 'Ah thank you sir 🙏' }),
    msg({
      waMessageId: `s${run}-c`,
      senderName: 'Amina',
      text: 'abeg who get the past questions?',
    }),
    msg({
      waMessageId: `s${run}-d`,
      senderName: 'Dr. Musa',
      text: `STA 202 assignment submission is due today ${today} at 11:59pm.`,
    }),
    msg({
      waMessageId: `s${run}-f`,
      senderName: 'Dr. Bello',
      text: `Reminder: the CSC 301 assignment is also due today ${today}, 5pm sharp.`,
    }),
  ]

  for (const fixture of fixtures) {
    await messageRepository.insertIfNew(fixture)
    const result = await extractionService.classify(fixture, { defaultCourse: 'CSC 301' })
    const rows = extractionService.toRows(fixture, result, 'CSC 301')
    await indexingService.index(fixture, fixture.text!, [rows[0]?.courseKey ?? 'CSC301'])
    if (rows.length) await extractionRepository.insertMany(rows)

    const summary = rows.length
      ? rows
          .map((r) =>
            `${r.courseKey} ${r.eventType} ${r.date ?? 'no-date'} ${r.time ?? ''} ${r.venue ?? ''}`.trim(),
          )
          .join(' | ')
      : '—'
    console.log(
      `${result.kind.padEnd(13)} ${JSON.stringify(fixture.text?.slice(0, 44))} → ${summary}`,
    )
  }

  const stored = await extractionRepository.forCourses(['CSC301'], new Date(Date.now() - 60_000))
  const test = stored.find((e) => e.eventType === 'test')
  const expected = inThreeDays.iso
  console.log(
    `\ndate check: said "this ${inThreeDaysName}" → got ${test?.date ?? 'null'}, expected ${expected} ${test?.date === expected ? '✅' : '❌'}`,
  )

  section('3. quoted-message context')
  const correction = msg({
    waMessageId: `s${run}-e`,
    senderName: 'Dr. Bello',
    text: 'No, it is LG8.',
    quotedMessageId: `s${run}-a`,
  })
  await messageRepository.insertIfNew(correction)
  const quotedResult = await extractionService.classify(correction, {
    defaultCourse: 'CSC 301',
    quotedText: fixtures[0]!.text,
  })
  console.log(
    `"No, it is LG8." with quote → ${quotedResult.kind}: ${JSON.stringify(quotedResult.announcements.map((a) => `${a.eventType} @ ${a.venue}`))}`,
  )

  section('4. document filing (tag, do not read)')
  for (const [fileName, caption] of [
    ['CSC301_wk3_slides.pdf', null],
    ['CSC301_past_questions_2023.pdf', null],
    ['brief.pdf', 'CSC 301 assignment brief, due next week'],
  ] as const) {
    const key = `document/smoke-${run}-${fileName}`
    await putMedia(key, Buffer.from(`%PDF-1.4 stub ${fileName}`), 'application/pdf')
    const document = msg({
      waMessageId: `s${run}-doc-${fileName}`,
      senderName: 'Dr. Bello',
      type: 'document',
      fileName,
      caption,
      mediaKey: key,
      mimeType: 'application/pdf',
    })
    await messageRepository.insertIfNew(document)
    const filed = await documentService.file(document, [], 'CSC 301')
    console.log(`${fileName.padEnd(34)} → ${filed?.courseKey} / ${filed?.docType}`)
  }

  section('5. resource request returns the shelf and the files')
  await userRepository.upsert({
    phone: STUDENT_PHONE,
    jid: STUDENT_JID,
    name: 'Amina',
    displayName: 'Amina',
    courseKeys: ['CSC301', 'STA202'],
    onboardingState: 'registered',
    registeredAt: new Date(),
    lastDigestAt: null,
    digestFormat: 'text',
    digestHour: 7,
    quietFrom: null,
    quietTo: null,
    pausedUntil: null,
    paused: false,
    digestPaused: false,
    alertLevel: 'all',
    mutedCourseKeys: [],
  })
  const student = (await userRepository.findByPhone(STUDENT_PHONE))!
  outbox.length = 0
  const { summary, files } = await resourceService.shelf(student, 'CSC 301 resources')
  console.log(summary)
  const sent = await resourceService.sendFiles(student, files)
  console.log(`\nfiles actually sent: ${sent} (summary went first)`)

  section('6. cited Q&A')
  for (const question of ['when is the CSC 301 test?', 'where is it holding?']) {
    console.log(`\nQ: ${question}\nA: ${await qaService.answer(question, ['CSC301', 'STA202'])}`)
  }

  section('7. daily digest')
  outbox.length = 0
  await digestService.runFor({ ...student, lastDigestAt: new Date(Date.now() - 86_400_000) })
  console.log(outbox.join('\n\n') || '(nothing to send)')

  section('8. deadline warning with the brief attached')
  await getDb().collection('notifications').deleteMany({ userPhone: STUDENT_PHONE })
  outbox.length = 0
  await deadlineService.runFor(student, today)
  console.log(outbox.join('\n\n') || '(nothing due today)')

  section('9. re-running the deadline job does not double-send')
  outbox.length = 0
  await deadlineService.runFor(student, today)
  console.log(
    outbox.length === 0
      ? '✅ second run sent nothing — the notification log guarded it'
      : `❌ re-sent ${outbox.length} message(s)`,
  )

  section('10. empty digest says so plainly')
  outbox.length = 0
  await digestService.runFor({
    ...student,
    courseKeys: ['ZZZ999'],
    lastDigestAt: new Date(Date.now() - 86_400_000),
  })
  console.log(outbox.join('\n') || '❌ sent nothing at all')

  await closeMongo()
  console.log('\n✅ smoke complete\n')
}

main().catch((error) => {
  logger.fatal({ err: error }, 'smoke failed')
  process.exit(1)
})
