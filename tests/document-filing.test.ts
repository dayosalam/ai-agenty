import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Resource } from '../src/models/index.js'

const filed: Resource[] = []
let tag: { course: string | null; docType: string; confidence: number } | null = null

vi.mock('../src/repositories/index.js', () => ({
  resourceRepository: {
    insert: vi.fn(async (resource: Resource) => {
      filed.push(resource)
    }),
  },
}))

vi.mock('../src/services/openai.client.js', () => ({
  getOpenAI: () => ({
    beta: {
      chat: {
        completions: { parse: vi.fn(async () => ({ choices: [{ message: { parsed: tag } }] })) },
      },
    },
  }),
}))

const { documentService } = await import('../src/services/document.service.js')

function pdf(fileName: string): Message {
  return {
    waMessageId: `m-${fileName}`,
    chatJid: '1@g.us',
    senderName: 'Class rep',
    type: 'document',
    fileName,
    mediaKey: `doc/${fileName}`,
    mimeType: 'application/pdf',
    timestamp: new Date(),
  } as unknown as Message
}

beforeEach(() => {
  filed.length = 0
  tag = { course: null, docType: 'other', confidence: 0.5 }
})

/**
 * A file with no course is invisible to every question about that course: the student
 * is told nothing was ever shared, while Peermate is holding it. The model returned
 * null for "CVE 565.pdf" in the same batch where it filed "Unilorin_CVE575_Course
 * 1-3.pdf" correctly, so the code written in the name cannot be left to its judgement.
 */
describe('filing a document', () => {
  it('takes the course from the filename when the model missed it', async () => {
    await documentService.file(pdf('CVE 565.pdf'), [], null)
    expect(filed[0]!.courseKey).toBe('CVE565')
  })

  it('reads a code that is not at the start', async () => {
    await documentService.file(pdf('Unilorin_CVE575_ClassNotes.pdf'), [], null)
    expect(filed[0]!.courseKey).toBe('CVE575')
  })

  /** "Assignment 2023" parses as a course code; a year is not a course number. */
  it('is not fooled by a year inside the filename', async () => {
    tag = { course: 'CVE 581', docType: 'assignment', confidence: 0.9 }
    await documentService.file(pdf('CVE 581_Assignment 2023_24 Session.docx.pdf'), [], null)
    expect(filed[0]!.courseKey).toBe('CVE581')
  })

  /** Two codes is not a filing decision — only the surrounding words can settle it. */
  it('leaves an ambiguous filename to the model', async () => {
    tag = { course: 'MTH 101', docType: 'slides', confidence: 0.8 }
    await documentService.file(pdf('CVE575_and_MTH101_combined.pdf'), [], null)
    expect(filed[0]!.courseKey).toBe('MTH101')
  })

  it('falls back to the group when neither names a course', async () => {
    await documentService.file(pdf('lecture_notes_2024.pdf'), [], 'CVE 575')
    expect(filed[0]!.courseKey).toBe('CVE575')
  })

  it('files with no course rather than guessing one', async () => {
    await documentService.file(pdf('scan001.pdf'), [], null)
    expect(filed[0]!.courseKey).toBeNull()
  })
})
