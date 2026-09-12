import { zodResponseFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { Message, ScheduleEntry } from '../models/index.js'
import { ScheduleKind } from '../models/index.js'
import { courseDisplay, parseCourseList } from '../utils/courses.js'
import {
  calendarWindow,
  isOfferedDate,
  isPlausibleAbsoluteDate,
  isoFromAnswer,
} from '../utils/dates.js'
import { getOpenAI } from './openai.client.js'

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/**
 * Strict mode requires every property, so absence is null rather than omitted.
 * The verdict comes first for the same reason it does in extraction: the model
 * commits to what the picture *is* before it feels any pressure to fill in rows.
 */
const LlmRow = z.object({
  course: z.string().nullable(),
  title: z.string().nullable(),
  lecturer: z.string().nullable(),
  kind: ScheduleKind,
  weekday: z.string().nullable(),
  date: z.string().nullable(),
  time: z.string().nullable(),
  venue: z.string().nullable(),
})

const LlmTimetable = z.object({
  kind: z.enum(['course_list', 'exam_timetable', 'class_timetable', 'other']),
  /** Course codes when it is only a list, with no times attached. */
  courses: z.array(z.string()),
  rows: z.array(LlmRow),
  /** True when the picture is too blurred, cropped or dark to read properly. */
  unreadable: z.boolean(),
})
export type Timetable = z.infer<typeof LlmTimetable>

export interface ReadTimetable {
  kind: Timetable['kind']
  unreadable: boolean
  courseKeys: string[]
  entries: ScheduleEntry[]
  /**
   * Rows whose written day contradicts the date they resolved to.
   *
   * Almost always means the picture is from another year — a re-used exam timetable
   * whose "Tuesday 11/02" was a Tuesday in 2025 but is a Thursday now.
   */
  mismatches: Array<{ course: string | null; written: string; resolved: string }>
  /**
   * Dated items whose date could not be placed on the calendar at all — which is
   * what a timetable from a past session looks like, since the offered window only
   * ever looks forward.
   */
  undated: Array<string | null>
  /** Titles and lecturers worth remembering, so "structural analysis" resolves later. */
  courses: Array<{ courseKey: string; code: string; title: string | null; lecturer: string | null }>
}

const SYSTEM = `You read a photograph a Nigerian university student sent of their own timetable or course list. The text below was produced by OCR, so it may be imperfect.

Decide what the picture IS, first:
- "course_list" — just course codes, with no days or times. A registration printout, a handwritten list.
- "exam_timetable" — exams or tests on specific calendar dates.
- "class_timetable" — the weekly pattern: lectures, tutorials, practicals that repeat every week on a weekday.
- "other" — anything else. A lecture slide, a receipt, a photo of a person, a screenshot of a chat.

Set unreadable true when the text is too garbled, cropped or sparse to trust. Never fill rows from a picture you cannot read.

For "course_list": put the codes in courses, leave rows empty.

For "exam_timetable" and "class_timetable": one row per scheduled item.
- course: the code as written, "CVE 575" style. Null if there is no code.
- title: the course name if the picture gives one — "Advanced Structural Analysis". Null otherwise, never an empty string.
- lecturer: the staff name against that row, if any. Null otherwise, never an empty string.
- kind: exam, test, lecture, tutorial or practical. A weekly timetable is lecture unless it says otherwise.
- weekday: the day name as WRITTEN on the picture — "Monday". Give it for dated exams too, exactly as the picture says, so the day and the date can be checked against each other. Null only when the picture names no day.
- date: for a DATED item, find the matching line in the calendar offered below and return ONLY its YYYY-MM-DD part, without the weekday in front. Null for a weekly item, and null if no line matches.
- time: 24-hour "14:00". Use the START time when a range is given. Null if absent.
- venue: the room or hall. Null if absent.

Dates are written day/month, as they are in Nigeria: "11/02" is 11 February, never 2 November.

Never invent a row. An empty timetable is a correct answer. Do not carry a value from one row into the next just because the cell was blank — a blank cell is null.`

/**
 * Reads a student's own timetable out of a photograph.
 *
 * Separate from extraction, which answers "what did somebody announce?". This answers
 * "what is this picture of, and what is on it?" — a different question with a
 * different failure mode. Extraction filling in a blank produces a phantom
 * announcement sent to a whole class; this one produces a wrong reminder for one
 * student, which is why the result is read back to them before anything is stored.
 */
export class TimetableService {
  /** Worth attempting only when there is OCR text to work with. */
  looksLikeTimetable(message: Message): boolean {
    if (message.type !== 'image') return false
    return Boolean(message.transcript?.trim())
  }

  async read(message: Message): Promise<ReadTimetable | null> {
    const ocr = message.transcript?.trim()
    if (!ocr) return null

    const caption = message.caption?.trim()
    const window = calendarWindow(message.timestamp, config.digest.timezone, 200)

    try {
      const completion = await getOpenAI().beta.chat.completions.parse({
        model: config.openai.extractionModel,
        messages: [
          {
            role: 'system',
            content: `${SYSTEM}\n\nDates you may choose from:\n${window.map((day) => day.label).join('\n')}`,
          },
          {
            role: 'user',
            content: [caption ? `They said: "${caption}"` : null, `The picture reads:\n${ocr}`]
              .filter(Boolean)
              .join('\n\n'),
          },
        ],
        response_format: zodResponseFormat(LlmTimetable, 'timetable'),
      })

      const parsed = completion.choices[0]?.message.parsed
      if (!parsed) return null

      logger.info(
        { kind: parsed.kind, rows: parsed.rows.length, unreadable: parsed.unreadable },
        'timetable read',
      )
      logger.debug({ rows: parsed.rows }, 'timetable rows as returned')
      return this.toEntries(parsed, message, window)
    } catch (error) {
      logger.error({ err: error }, 'could not read timetable')
      return null
    }
  }

  private toEntries(
    parsed: Timetable,
    message: Message,
    window: ReturnType<typeof calendarWindow>,
  ): ReadTimetable {
    const courses = new Map<
      string,
      { courseKey: string; code: string; title: string | null; lecturer: string | null }
    >()

    // parseCourseList, not courseKey: timetables abbreviate a shared prefix, and
    // courseKey("CVE 567/577") collapses to the single nonsense code CVE567577.
    const remember = (
      raw: string | null,
      title: string | null,
      lecturer: string | null,
    ): string[] => {
      const keys = raw ? parseCourseList(raw) : []
      for (const key of keys) {
        const existing = courses.get(key)
        courses.set(key, {
          courseKey: key,
          code: courseDisplay(key) ?? key,
          // Empty strings, which the model returns instead of null, defeat ?? and
          // would overwrite a real title learned from somewhere else.
          title: blankToNull(title) ?? existing?.title ?? null,
          lecturer: blankToNull(lecturer) ?? existing?.lecturer ?? null,
        })
      }
      return keys
    }

    for (const code of parsed.courses) remember(code, null, null)

    const entries: ScheduleEntry[] = []
    const mismatches: ReadTimetable['mismatches'] = []
    const undated: Array<string | null> = []

    for (const row of parsed.rows) {
      const keys = remember(row.course, row.title, row.lecturer)
      const weekday = weekdayIndex(row.weekday)

      // Same rule as extraction: a date the model chose from the offered calendar, or
      // an explicit one that survives validation. Anything else is dropped to null
      // rather than becoming a reminder that fires on a day nobody named.
      const offered = isoFromAnswer(row.date)
      const date =
        offered &&
        (isOfferedDate(offered, window) || isPlausibleAbsoluteDate(offered, message.timestamp))
          ? offered
          : null

      // The picture names a day AND a date, so they can be checked against each
      // other. When they disagree the date is from another year — a re-used exam
      // timetable whose "Tuesday 11/02" was a Tuesday in 2025 and is a Thursday now.
      // Storing it anyway schedules a reminder for a day the student was never told.
      if (date !== null && weekday !== null && utcWeekday(date) !== weekday) {
        mismatches.push({
          course: keys[0] ? (courseDisplay(keys[0]) ?? null) : null,
          written: WEEKDAYS[weekday]!,
          resolved: `${WEEKDAYS[utcWeekday(date)]!} ${date}`,
        })
        continue
      }

      // An exam happens once. Falling back to its weekday would store it as
      // recurring and remind the student every Tuesday for the rest of the year.
      const dated = row.kind === 'exam' || row.kind === 'test'
      if (dated && date === null) {
        undated.push(keys[0] ? (courseDisplay(keys[0]) ?? null) : null)
        continue
      }

      // A row that pins nothing to a moment cannot remind anyone of anything.
      if (date === null && weekday === null) continue

      // A dated event does not recur. Leaving the weekday set would file an exam
      // under the weekly timetable and remind about it every week.
      for (const key of keys.length > 0 ? keys : [null]) {
        entries.push({
          phone: '',
          course: key ? (courseDisplay(key) ?? null) : null,
          courseKey: key,
          kind: row.kind,
          date,
          weekday: date === null ? weekday : null,
          time: normaliseTime(row.time),
          venue: blankToNull(row.venue),
          sourceMessageId: message.waMessageId,
          createdAt: new Date(),
        })
      }
    }

    // One sheet is one sheet. If its days and dates disagree anywhere, the whole
    // thing is from another session — and a row that happens to line up did so by
    // coincidence, not because it is right. Keeping that one survivor would schedule
    // a single confident exam reminder out of a timetable known to be wrong.
    const trustworthy = mismatches.length === 0 ? entries : entries.filter((entry) => !entry.date)
    if (mismatches.length > 0 && entries.length !== trustworthy.length) {
      logger.warn(
        { mismatches: mismatches.length, dropped: entries.length - trustworthy.length },
        'timetable days contradict its dates, discarding every dated row',
      )
    }

    return {
      kind: parsed.kind,
      unreadable: parsed.unreadable,
      courseKeys: [...courses.keys()],
      entries: trustworthy,
      mismatches,
      undated,
      courses: [...courses.values()],
    }
  }
}

/** The weekday an ISO date actually falls on, read at noon UTC to dodge any edge. */
function utcWeekday(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay()
}

function weekdayIndex(name: string | null): number | null {
  if (!name) return null
  const index = WEEKDAYS.indexOf(name.trim().toLowerCase().slice(0, 9))
  if (index >= 0) return index
  return WEEKDAYS.findIndex((day) => day.startsWith(name.trim().toLowerCase().slice(0, 3)))
}

function normaliseTime(time: string | null): string | null {
  if (!time) return null
  const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(time.trim())
  if (!match) return /^\d{1,2}:\d{2}$/.test(time.trim()) ? time.trim() : null
  const hours = Number(match[1])
  if (hours > 23) return null
  return `${String(hours).padStart(2, '0')}:${match[2] ?? '00'}`
}

/**
 * OCR fills empty cells with dashes and placeholders, and the model fills them with
 * the word "null" written out. None of those is a venue or a course title, and an
 * empty string defeats `??` — so a stray "" would overwrite a real value later.
 */
function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim()
  if (!trimmed || /^[/\\-]*(null|none|n\/?a|tbd|tba|nil|-+)$/i.test(trimmed)) return null
  return trimmed
}

export const timetableService = new TimetableService()
