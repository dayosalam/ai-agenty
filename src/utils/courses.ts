/**
 * Canonical course identity.
 *
 * The extractor will return "CSC 301", "CSC301" and "csc 301" for the same course,
 * and a student typing their courses into a DM will do the same. Everything that
 * matches — subscriptions, retrieval filters, the library — matches on the key, so
 * that a student who wrote "csc301" at onboarding still receives the announcement a
 * lecturer phrased as "CSC 301".
 *
 * Without this the failure is silent: an exact string match returns nothing, no
 * error is raised anywhere, and the student simply never hears from Peermate again.
 */

const NON_ALNUM = /[^A-Za-z0-9]/g
const SPLIT_CODE = /^([A-Z]{2,4})(\d{3,4})$/
const COURSE_TOKEN = /[A-Za-z]{2,4}\s?\d{3,4}/g
/** "CVE 567/577" and "CVE 567 & 577" are two courses sharing one prefix. */
const SHARED_PREFIX = /\b([A-Za-z]{2,4})\s?(\d{3,4})(?:\s*[/&,]\s*(\d{3,4}))+/g

/** Canonical form used for every comparison: 'csc 301' -> 'CSC301'. */
export function courseKey(course: string | null | undefined): string | null {
  if (!course) return null
  const key = course.replace(NON_ALNUM, '').toUpperCase()
  return key || null
}

/**
 * Human form used in digests and answers: 'csc301' -> 'CSC 301'.
 *
 * Falls back to the caller's own string when it isn't a recognisable code, so a
 * course named in words is shown as the sender wrote it.
 */
export function courseDisplay(course: string | null | undefined): string | null {
  const key = courseKey(course)
  if (key === null) return null
  const match = SPLIT_CODE.exec(key)
  if (match) return `${match[1]} ${match[2]}`
  return course ? course.trim() : null
}

/**
 * Read the courses a student types during onboarding into canonical keys.
 *
 * Accepts the shapes people actually send: commas, newlines, 'and', or just
 * spaces between codes.
 */
export function parseCourseList(raw: string): string[] {
  const keys: string[] = []
  const add = (value: string | null): void => {
    if (value && !keys.includes(value)) keys.push(value)
  }

  // Timetables abbreviate a shared prefix: "CVE 567/577" is CVE 567 and CVE 577.
  // Read those first, because the ordinary token match would silently drop the tail.
  for (const match of raw.matchAll(SHARED_PREFIX)) {
    const prefix = match[1]!
    for (const number of match[0].match(/\d{3,4}/g) ?? []) {
      add(courseKey(`${prefix}${number}`))
    }
  }

  for (const candidate of raw.split(/[,\n;]+|\band\b/i)) {
    for (const token of candidate.match(COURSE_TOKEN) ?? []) {
      add(courseKey(token))
    }
  }
  return keys
}
