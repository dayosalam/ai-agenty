import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../src/models/index.js'
import { calendarWindow, isoFromAnswer } from '../src/utils/dates.js'

vi.mock('../src/services/openai.client.js', () => ({ getOpenAI: vi.fn() }))

const { TimetableService } = await import('../src/services/timetable.service.js')
const service = new TimetableService()

/** toEntries is private by design; this is the same path read() takes. */
const NOW = new Date('2026-09-12T10:00:00+01:00')
const window = calendarWindow(NOW, 'Africa/Lagos', 200)

const message = { waMessageId: 'img-1', timestamp: NOW, type: 'image' } as Message

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    course: 'CVE 575',
    title: null,
    lecturer: null,
    kind: 'exam',
    weekday: null,
    date: null,
    time: '08:30',
    venue: 'NELT 1',
    ...over,
  }
}

interface Result {
  entries: Array<Record<string, unknown>>
  mismatches: unknown[]
  undated: unknown[]
  courses: Array<{ courseKey: string; title: string | null }>
}

const read = (rows: Array<Record<string, unknown>>, kind = 'exam_timetable'): Result =>
  (Reflect.get(service, 'toEntries') as (p: unknown, m: Message, w: unknown) => Result).call(
    service,
    { kind, courses: [], rows, unreadable: false },
    message,
    window,
  )

/**
 * The calendar is offered as labels — "Tue 2026-09-22" — because the weekday is what
 * stops the model doing its own arithmetic. Asked to copy a value from that list it
 * copies the whole label, and validating the raw string silently dropped the date.
 */
describe('the date the model actually returns', () => {
  it('pulls the ISO date out of an offered label', () => {
    expect(isoFromAnswer('Tue 2026-09-22')).toBe('2026-09-22')
    expect(isoFromAnswer('2026-09-22')).toBe('2026-09-22')
    expect(isoFromAnswer('next Tuesday')).toBeNull()
    expect(isoFromAnswer(null)).toBeNull()
  })

  it('accepts and stores a labelled date', () => {
    const result = read([row({ date: 'Tue 2026-09-22', weekday: 'Tuesday' })])
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.date).toBe('2026-09-22')
  })
})

/**
 * The regression this exists for: a real exam timetable from February 2025, uploaded
 * in September 2026. Every written weekday contradicted the date it resolved to.
 */
describe('a timetable from another session', () => {
  it('discards every dated row when the days and dates disagree', () => {
    const result = read([
      row({ course: 'CVE 575', date: '2026-11-02', weekday: 'Tuesday' }),
      row({ course: 'ABE 501', date: '2026-11-03', weekday: 'Wednesday' }),
    ])

    expect(result.entries).toHaveLength(0)
    expect(result.mismatches).toHaveLength(2)
  })

  /** A row that lines up inside a sheet known to be wrong did so by coincidence. */
  it('does not keep the one row that happens to match', () => {
    const result = read([
      row({ course: 'CVE 575', date: '2026-11-02', weekday: 'Tuesday' }),
      row({ course: 'CVE 581', date: '2026-11-16', weekday: 'Monday' }),
    ])

    expect(result.entries).toHaveLength(0)
  })

  it('reports dated items whose date could not be placed at all', () => {
    const result = read([row({ course: 'CVE 575', date: null, weekday: 'Tuesday' })])
    expect(result.entries).toHaveLength(0)
    expect(result.undated).toEqual(['CVE 575'])
  })
})

describe('what a row becomes', () => {
  /** "CVE 567/577" is two exams; courseKey collapses it to one nonsense code. */
  it('splits a shared course prefix into both courses', () => {
    const result = read([
      row({ course: 'CVE 567/577', date: 'Thu 2026-09-24', weekday: 'Thursday' }),
    ])

    expect(result.entries.map((entry) => entry.courseKey)).toEqual(['CVE567', 'CVE577'])
  })

  /** An exam happens once; a leftover weekday would remind them every Tuesday. */
  it('clears the weekday on a dated event', () => {
    const result = read([row({ date: 'Tue 2026-09-22', weekday: 'Tuesday' })])
    expect(result.entries[0]!.weekday).toBeNull()
    expect(result.entries[0]!.date).toBe('2026-09-22')
  })

  it('keeps the weekday on a weekly class', () => {
    const result = read(
      [row({ kind: 'lecture', weekday: 'Tuesday', date: null })],
      'class_timetable',
    )
    expect(result.entries[0]!.weekday).toBe(2)
    expect(result.entries[0]!.date).toBeNull()
  })

  /** An empty string defeats ??, so it would overwrite a title learned elsewhere. */
  it('reads the placeholders the model returns as nothing', () => {
    const result = read([row({ title: '', lecturer: '/null', venue: '-', date: 'Tue 2026-09-22' })])

    expect(result.courses[0]!.title).toBeNull()
    expect(result.entries[0]!.venue).toBeNull()
  })
})
