/**
 * Checks which announcements count as "the same event".
 *
 * The rules live in a Mongo query, so they can only be verified against a real one.
 * Run with: npx tsx src/scripts/dedupe-check.ts
 */
import { logger } from '../core/logger.js'
import { closeMongo, connectMongo, getDb } from '../db/mongo.js'
import type { Extraction } from '../models/index.js'
import { extractionRepository } from '../repositories/index.js'

const COURSE = 'ZZZDEDUPE'

function row(over: Partial<Extraction>): Extraction {
  return {
    eventId: `dd-${Math.random().toString(36).slice(2, 9)}`,
    sourceMessageId: 'src',
    chatJid: '1@g.us',
    course: 'ZZZ 999',
    courseKey: COURSE,
    eventType: 'assignment',
    originalDateText: null,
    date: '2026-09-20',
    time: null,
    venue: null,
    confidence: 0.9,
    authority: 'student',
    corroboratedBy: [],
    extractedAt: new Date(),
    ...over,
  } as Extraction
}

async function check(
  label: string,
  first: Partial<Extraction>,
  second: Partial<Extraction>,
  shouldMatch: boolean,
): Promise<boolean> {
  await getDb().collection('extractions').deleteMany({ courseKey: COURSE })
  const a = row(first)
  await extractionRepository.insertMany([a])

  const b = row(second)
  const found = await extractionRepository.findSimilar(b)
  const matched = found !== null
  const ok = matched === shouldMatch

  console.log(
    `${ok ? '✅' : '❌'} ${label}\n     ${shouldMatch ? 'same event' : 'different events'} — got ${matched ? 'same' : 'different'}`,
  )
  return ok
}

async function main(): Promise<void> {
  await connectMongo()
  const results: boolean[] = []

  console.log('\n── must NOT merge ──')
  results.push(
    await check(
      'two assignments due the same day, different times',
      { time: '17:00' },
      { time: '23:59' },
      false,
    ),
  )
  results.push(
    await check(
      'two tests the same day, different times',
      { eventType: 'test', time: '08:00' },
      { eventType: 'test', time: '14:00' },
      false,
    ),
  )
  results.push(
    await check(
      'two undated assignments — unknowable, so never merged',
      { date: null },
      { date: null },
      false,
    ),
  )
  results.push(
    await check(
      'same slot, different venues — a conflict the student must see',
      { time: '10:00', venue: 'LG7' },
      { time: '10:00', venue: 'LT2' },
      false,
    ),
  )
  results.push(await check('different days', { date: '2026-09-20' }, { date: '2026-09-21' }, false))
  results.push(
    await check('different event types', { eventType: 'test' }, { eventType: 'assignment' }, false),
  )

  console.log('\n── must merge ──')
  results.push(
    await check(
      'identical announcements from two classmates',
      { time: '17:00' },
      { time: '17:00' },
      true,
    ),
  )
  results.push(
    await check(
      '"test Friday" then "test Friday 10am" — one test, told twice',
      { time: null },
      { time: '10:00' },
      true,
    ),
  )
  results.push(
    await check(
      'a venue added later',
      { time: '10:00', venue: null },
      { time: '10:00', venue: 'LG7' },
      true,
    ),
  )

  console.log('\n── enrichment ──')
  await getDb().collection('extractions').deleteMany({ courseKey: COURSE })
  const sparse = row({ eventId: 'dd-sparse', time: null, venue: null })
  await extractionRepository.insertMany([sparse])
  await extractionRepository.enrich('dd-sparse', row({ time: '10:00', venue: 'LG7' }))
  const filled = await extractionRepository.findByEventId('dd-sparse')
  const enriched = filled?.time === '10:00' && filled?.venue === 'LG7'
  console.log(
    `${enriched ? '✅' : '❌'} gaps filled from the fuller telling → ${filled?.time} ${filled?.venue}`,
  )
  results.push(enriched)

  const stated = row({ eventId: 'dd-stated', time: '08:00', venue: 'LG7' })
  await extractionRepository.insertMany([stated])
  await extractionRepository.enrich('dd-stated', row({ time: '23:59', venue: 'LT2' }))
  const kept = await extractionRepository.findByEventId('dd-stated')
  const preserved = kept?.time === '08:00' && kept?.venue === 'LG7'
  console.log(
    `${preserved ? '✅' : '❌'} a stated value is never overwritten → ${kept?.time} ${kept?.venue}`,
  )
  results.push(preserved)

  await getDb().collection('extractions').deleteMany({ courseKey: COURSE })
  await closeMongo()

  const failed = results.filter((r) => !r).length
  console.log(
    `\n${failed === 0 ? '✅ all' : `❌ ${failed} of ${results.length}`} checks ${failed === 0 ? 'passed' : 'failed'}\n`,
  )
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  logger.fatal({ err: error }, 'dedupe check failed')
  process.exit(1)
})
