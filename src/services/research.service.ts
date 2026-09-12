import { config } from '../config.js'
import { logger } from '../core/logger.js'

/**
 * What a course is actually about, as opposed to what it is called.
 *
 * A course code is a local invention: "CVE 575" means nothing outside the university
 * that issued it, and a web search for it matches "MATH 575" just as happily. The
 * subject is what makes the search work, so the code is only ever a last resort.
 */
export interface Subject {
  code: string
  /** "Transportation Engineering" — from the courses record or from their words. */
  title: string | null
  /** Anything else they said about what they want. */
  words: string
}

export interface Reading {
  topic: string
  title: string
  url: string
  /** A line or two from the page itself, never the model's summary of it. */
  extract: string | null
}

const ENDPOINT = 'https://api.exa.ai/search'

/** Every PDF starts with this. A page that says it is one and is not is an HTML error. */
const PDF_MAGIC = '%PDF-'

/**
 * Further reading for a topic, from Exa.
 *
 * Deliberately narrow. The topics come from the course files and nowhere else, so
 * the web is only ever asked to explain something a lecturer already put in front of
 * the student. Exa never sees the student's question, never contributes a quiz
 * question and never supplies a fact Peermate repeats as its own — what comes back is
 * a link, labelled as a link, for the student to decide about.
 *
 * That boundary is the point: a test is set from the course material. A model that
 * revises you on what the internet finds interesting about "shear force" is
 * confidently preparing you for the wrong exam.
 */
export class ResearchService {
  async readingFor(topics: string[], course: string): Promise<Reading[]> {
    if (!config.research.enabled) return []

    const wanted = topics.slice(0, config.research.topicsResearched)
    const found = await Promise.all(wanted.map((topic) => this.search(topic, course)))
    return found.flat()
  }

  /**
   * Downloadable PDFs on a course's subject, for when the group has none.
   *
   * A separate call from `readingFor` because it wants a different thing: something
   * whole that can be read offline on a phone, not a page to skim. Results that are
   * not PDFs are dropped rather than sent as links — the student asked for material.
   *
   * Results are then checked against the subject. Searching on a bare course number
   * returns whatever else is numbered that way, and a Math 575 review sheet offered
   * for a transportation engineering course is not a near miss — it is the wrong
   * subject entirely, and the student cannot tell before they open it.
   */
  async documentsFor(subject: Subject, exclude: string[] = []): Promise<Reading[]> {
    if (!config.research.enabled) return []

    const about = [subject.title, subject.words].filter(Boolean).join(' ').trim()
    const found = await this.query(
      `${about || subject.code} — university lecture notes, handout or past questions (PDF)`,
      config.research.fileResults,
    )

    const keywords = meaningful(about)
    return found
      .filter((result) => isPdf(result.url))
      .filter((result) => !exclude.includes(result.url))
      .filter((result) => onSubject(result, keywords))
      .map((result) => ({
        topic: about || subject.code,
        title: result.title,
        url: result.url,
        extract: result.extract,
      }))
  }

  /**
   * Fetches one of those PDFs.
   *
   * Checked rather than trusted: a URL ending in .pdf is a claim, and what comes back
   * is as often an HTML error page or a login wall. Sending that to a student as
   * course material is worse than sending nothing, so the bytes themselves have to
   * say they are a PDF.
   */
  async download(url: string): Promise<{ bytes: Buffer; fileName: string } | null> {
    if (!/^https?:\/\//i.test(url)) return null

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.research.downloadTimeoutMs)

    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
      if (!response.ok) return null

      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > config.research.maxFileBytes) {
        logger.info({ url, declared }, 'web pdf too large')
        return null
      }

      const bytes = Buffer.from(await response.arrayBuffer())
      // Checked again: content-length is optional and a chunked response has none.
      if (bytes.length > config.research.maxFileBytes) return null
      if (!bytes.subarray(0, PDF_MAGIC.length).toString('latin1').startsWith(PDF_MAGIC)) {
        logger.info({ url }, 'web pdf was not a pdf')
        return null
      }

      return { bytes, fileName: fileNameFrom(url) }
    } catch (error) {
      logger.warn({ err: error, url }, 'could not download web pdf')
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  private async search(topic: string, course: string): Promise<Reading[]> {
    // The course frames the topic: "modulus" alone returns finance, not engineering,
    // and a reading list that misses that is worse than none.
    const found = await this.query(
      `${topic} — university ${course} lecture notes and explanation`,
      config.research.resultsPerTopic,
    )
    return found.map((result) => ({ ...result, topic }))
  }

  private async query(
    query: string,
    numResults: number,
  ): Promise<Array<{ title: string; url: string; extract: string | null }>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.research.timeoutMs)

    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.research.apiKey,
        },
        body: JSON.stringify({
          query,
          numResults,
          type: 'auto',
          contents: { text: { maxCharacters: config.research.maxCharacters } },
        }),
        signal: controller.signal,
      })

      if (!response.ok) {
        logger.warn({ status: response.status, query }, 'exa search failed')
        return []
      }

      const body = (await response.json()) as { results?: ExaResult[] }
      return (body.results ?? []).flatMap((result) =>
        result.url && result.title
          ? [{ title: result.title, url: result.url, extract: clean(result.text) }]
          : [],
      )
    } catch (error) {
      // A search that times out must not take the answer down with it.
      logger.warn({ err: error, query }, 'exa search failed')
      return []
    } finally {
      clearTimeout(timer)
    }
  }
}

interface ExaResult {
  title?: string | null
  url?: string | null
  text?: string | null
}

/** Words worth matching on. Short ones match everything and so mean nothing. */
function meaningful(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z]{5,}/g) ?? [])]
}

/**
 * Whether a result is about the subject at all.
 *
 * One word is enough — a handout on "transportation planning" is about a course in
 * transportation engineering. Nothing at all is what disqualifies it.
 */
function onSubject(
  result: { title: string; url: string; extract: string | null },
  keywords: string[],
): boolean {
  if (keywords.length === 0) return true
  const haystack = `${result.title} ${result.url} ${result.extract ?? ''}`.toLowerCase()
  return keywords.some((word) => haystack.includes(word))
}

function isPdf(url: string): boolean {
  return /\.pdf(\?|#|$)/i.test(url)
}

/** WhatsApp shows the filename, so it has to survive being read off a phone screen. */
function fileNameFrom(url: string): string {
  const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '')
  const safe = last.replace(/[^\w.\-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!safe) return 'material.pdf'
  return safe.toLowerCase().endsWith('.pdf') ? safe : `${safe}.pdf`
}

function clean(text: string | null | undefined): string | null {
  if (!text) return null
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length < 40) return null
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat
}

export const researchService = new ResearchService()
