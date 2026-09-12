import { describe, expect, it } from 'vitest'
import { courseDisplay, courseKey, parseCourseList } from '../src/utils/courses.js'

describe('courseKey', () => {
  it('collapses every spelling of a course onto one key', () => {
    for (const spelling of ['CSC 301', 'CSC301', 'csc 301', 'csc-301', ' Csc  301 ']) {
      expect(courseKey(spelling)).toBe('CSC301')
    }
  })

  it('returns null for empty and punctuation-only input', () => {
    expect(courseKey('')).toBeNull()
    expect(courseKey(null)).toBeNull()
    expect(courseKey('---')).toBeNull()
  })
})

describe('courseDisplay', () => {
  it('splits a recognisable code back into letters and digits', () => {
    expect(courseDisplay('csc301')).toBe('CSC 301')
    expect(courseDisplay('STA 202')).toBe('STA 202')
  })

  it('falls back to the sender’s own wording when it is not a code', () => {
    expect(courseDisplay('Dept Notices')).toBe('Dept Notices')
  })
})

describe('parseCourseList', () => {
  it('reads the shapes students actually type', () => {
    expect(parseCourseList('CSC 301, STA 202')).toEqual(['CSC301', 'STA202'])
    expect(parseCourseList('csc301 and sta202')).toEqual(['CSC301', 'STA202'])
    expect(parseCourseList('CSC 301\nSTA 202\nMTH101')).toEqual(['CSC301', 'STA202', 'MTH101'])
  })

  it('drops duplicates however they were spelled', () => {
    expect(parseCourseList('CSC 301, csc301')).toEqual(['CSC301'])
  })

  it('returns nothing rather than guessing when no code is present', () => {
    expect(parseCourseList('hi')).toEqual([])
  })
})

describe('parseCourseList on a photographed timetable', () => {
  // The OCR of a real handwritten exam timetable, titles and all.
  const timetable = `Examination Time Table
Tuesday 11/02   CVE 575        8:30-11:30   NELT 1
Wednesday 12/02 ABE 501        10:00-11:00  CBT
Thursday 13/02  CVE 567/577    3:30-6:30    ELT
Tuesday 18/02   WEE 511        8:30-11:30   NELT 2
Wednesday 19/02 CVE 565        12:00-3:00   ELT
Thursday 20/02  ABE 573        12-1         CBT
Monday 24/02    CVE 581        8:30-11:30   ELT`

  it('finds every course, including the shared-prefix pair', () => {
    // "CVE 567/577" is two courses; reading only the first silently loses an exam.
    expect(parseCourseList(timetable).sort()).toEqual(
      ['ABE501', 'ABE573', 'CVE565', 'CVE567', 'CVE575', 'CVE577', 'CVE581', 'WEE511'].sort(),
    )
  })

  it('is not fooled by venues, dates or times', () => {
    const keys = parseCourseList(timetable)
    for (const noise of ['NELT1', 'NELT2', 'CBT', 'ELT', '1102', '830']) {
      expect(keys).not.toContain(noise)
    }
  })
})
