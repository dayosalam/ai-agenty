import { describe, expect, it } from 'vitest'
import {
  DOCX_MIME,
  DOC_MIME,
  DocumentReaderService,
  PDF_MIME,
} from '../src/services/document-reader.service.js'

const reader = new DocumentReaderService()

describe('supports', () => {
  it('accepts the formats students actually share', () => {
    expect(reader.supports(PDF_MIME)).toBe(true)
    expect(reader.supports(DOCX_MIME)).toBe(true)
    expect(reader.supports(DOC_MIME)).toBe(true)
  })

  it('rejects everything else, so it is indexed as unreadable rather than dropped', () => {
    expect(reader.supports('application/zip')).toBe(false)
    expect(reader.supports('image/png')).toBe(false)
    expect(reader.supports(null)).toBe(false)
  })
})

describe('chunk', () => {
  // Distinguishable tokens: with repeated words, any slice matches anywhere and an
  // overlap assertion would pass or fail for the wrong reason.
  const text = Array.from({ length: 1000 }, (_, i) => `tok${String(i).padStart(4, '0')}`).join(' ')

  it('covers the whole document', () => {
    const chunks = reader.chunk(text, 4)
    expect(chunks.length).toBeGreaterThan(1)
    // Overlap means total length exceeds the source; nothing may be missing.
    const joined = chunks.map((c) => c.text).join('')
    expect(joined.length).toBeGreaterThanOrEqual(text.length)
  })

  it('overlaps consecutive chunks so a sentence is never split away from its answer', () => {
    const [first, second] = reader.chunk(text, 4)
    const tail = first!.text.slice(-60).trim()
    // Some run of tokens ending the first chunk must reappear in the second.
    const shared = tail.split(' ').slice(1).join(' ')
    expect(second!.text).toContain(shared)
  })

  it('loses no token across the chunk boundaries', () => {
    const chunks = reader.chunk(text, 4)
    const seen = new Set(chunks.flatMap((c) => c.text.split(/\s+/)).filter(Boolean))
    for (const token of text.split(' ')) expect(seen.has(token)).toBe(true)
  })

  it('assigns a page to every chunk for citation', () => {
    for (const chunk of reader.chunk(text, 4)) {
      expect(chunk.page).toBeGreaterThanOrEqual(1)
    }
  })

  it('numbers chunks consecutively from zero, since the index becomes the Chroma id', () => {
    const chunks = reader.chunk(text, 4)
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i))
  })

  it('returns a single chunk for a short document', () => {
    const chunks = reader.chunk('CSC 301 test Friday 10am LG7', 1)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.page).toBe(1)
  })

  it('returns nothing for empty text rather than an empty chunk', () => {
    expect(reader.chunk('', 1)).toEqual([])
    expect(reader.chunk('   ', 1)).toEqual([])
  })

  it('terminates on a document whose length is an exact multiple of the chunk size', () => {
    // A naive loop with overlap can fail to advance here and hang forever.
    const chunks = reader.chunk('x'.repeat(2400), 2)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.length).toBeLessThan(20)
  })
})
