import { describe, expect, it } from 'vitest'
import {
  calendarWindow,
  formatTime12,
  isOfferedDate,
  todayIso,
  zonedDay,
} from '../src/utils/dates.js'

const LAGOS = 'Africa/Lagos'

describe('zonedDay', () => {
  it('reads the date in Lagos, not the server timezone', () => {
    // 23:30 UTC is already the next day in Lagos (UTC+1).
    const day = zonedDay(new Date('2026-09-11T23:30:00Z'), LAGOS)
    expect(day.iso).toBe('2026-09-12')
    expect(day.weekday).toBe('Sat')
    expect(day.label).toBe('Sat 2026-09-12')
  })

  it('labels weekdays correctly', () => {
    expect(zonedDay(new Date('2026-09-18T12:00:00Z'), LAGOS).weekday).toBe('Fri')
  })
})

describe('calendarWindow', () => {
  const window = calendarWindow(new Date('2026-09-11T12:00:00Z'), LAGOS, 14)

  it('starts a day early so "yesterday" still resolves', () => {
    expect(window[0]?.iso).toBe('2026-09-10')
  })

  it('every label states the real weekday for its date', () => {
    for (const day of window) {
      const actual = new Date(`${day.iso}T12:00:00Z`).toLocaleDateString('en-GB', {
        timeZone: LAGOS,
        weekday: 'short',
      })
      expect(day.weekday).toBe(actual)
    }
  })

  it('the Friday after Fri 11 Sept 2026 is the 18th, not the 15th', () => {
    // The exact failure this exists to prevent: the model previously answered
    // 2026-09-15 for "this Friday", which is a Tuesday.
    const fridays = window.filter((day) => day.weekday === 'Fri').map((day) => day.iso)
    expect(fridays).toContain('2026-09-18')
    expect(fridays).not.toContain('2026-09-15')
  })
})

describe('isOfferedDate', () => {
  const window = calendarWindow(new Date('2026-09-11T12:00:00Z'), LAGOS, 14)

  it('accepts a date the model was actually offered', () => {
    expect(isOfferedDate('2026-09-18', window)).toBe(true)
  })

  it('rejects an invented date outside the window', () => {
    expect(isOfferedDate('2027-01-01', window)).toBe(false)
  })

  it('rejects null rather than treating it as valid', () => {
    expect(isOfferedDate(null, window)).toBe(false)
  })
})

describe('todayIso', () => {
  it('returns a plain ISO date', () => {
    expect(todayIso(LAGOS, new Date('2026-09-12T08:00:00Z'))).toBe('2026-09-12')
  })
})

describe('formatTime12', () => {
  it('converts stored 24-hour times to how people actually say them', () => {
    expect(formatTime12('23:59')).toBe('11:59pm')
    expect(formatTime12('17:00')).toBe('5pm')
    expect(formatTime12('10:00')).toBe('10am')
    expect(formatTime12('09:30')).toBe('9:30am')
  })

  it('handles both midnights correctly', () => {
    expect(formatTime12('00:00')).toBe('12am')
    expect(formatTime12('12:00')).toBe('12pm')
    expect(formatTime12('00:30')).toBe('12:30am')
  })

  it('drops ":00" so a whole hour reads naturally', () => {
    expect(formatTime12('14:00')).toBe('2pm')
    expect(formatTime12('14:05')).toBe('2:05pm')
  })

  it('passes through anything that is not a time rather than mangling it', () => {
    expect(formatTime12(null)).toBeNull()
    expect(formatTime12('')).toBeNull()
    expect(formatTime12('lunchtime')).toBe('lunchtime')
    expect(formatTime12('99:99')).toBe('99:99')
  })
})
