import { config } from '../config.js'
import type { User } from '../models/index.js'

/**
 * Whether now falls inside a student's quiet window.
 *
 * Nothing is dropped when it does — the digest covers everything since it last ran,
 * so a 2am announcement arrives in the morning instead of waking them.
 *
 * The window wraps past midnight, which is the normal case: 22:00 to 06:00.
 */
export function isQuietHour(student: User, now = new Date()): boolean {
  const { quietFrom, quietTo } = student
  if (quietFrom === null || quietTo === null || quietFrom === quietTo) return false

  const hour = hourIn(config.digest.timezone, now)
  return quietFrom < quietTo
    ? hour >= quietFrom && hour < quietTo
    : hour >= quietFrom || hour < quietTo
}

/** The hour as it reads in the given timezone, not the server's. */
export function hourIn(timeZone: string, now = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(now),
  )
}
