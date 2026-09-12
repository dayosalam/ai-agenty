import { describe, expect, it, vi } from 'vitest'
import type { User } from '../src/models/index.js'

vi.mock('../src/repositories/index.js', () => ({
  resourceRepository: { forCourse: vi.fn(async () => []) },
}))
vi.mock('../src/services/notifier.service.js', () => ({ notifierService: {} }))
vi.mock('../src/services/conversation.service.js', () => ({
  conversationService: { get: vi.fn(async () => null), expect: vi.fn() },
}))

const { resourceService } = await import('../src/services/resource.service.js')

const student = (courseKeys: string[]): User => ({ courseKeys }) as User

/**
 * The regression: "what did the lecturer say in the voice note?" matched on the word
 * "note" and dumped the entire file library instead of answering the question.
 */
describe('asking for files, versus a question that mentions one', () => {
  it('reads an explicit request', () => {
    for (const text of [
      'CSC 301 resources',
      'send me the past questions',
      'abeg share the slides',
      'do you have the course materials?',
      'what files do you have for CSC 301?',
    ]) {
      expect(resourceService.looksLikeRequest(text), text).toBe(true)
    }
  })

  it('leaves a question alone', () => {
    for (const text of [
      'what did the lecturer say in the voice note?',
      'when is the test?',
      'was there a note about the venue?',
      'who shared that?',
    ]) {
      expect(resourceService.looksLikeRequest(text), text).toBe(false)
    }
  })
})

describe('which course the files are for', () => {
  it('asks when the student takes several and named none', () => {
    expect(resourceService.needsCourse(student(['CSC301', 'STA202']), 'send me the slides')).toBe(
      true,
    )
  })

  it('does not ask when they named one', () => {
    expect(
      resourceService.needsCourse(student(['CSC301', 'STA202']), 'CSC 301 slides please'),
    ).toBe(false)
  })

  it('does not ask when there is only one course to mean', () => {
    expect(resourceService.needsCourse(student(['CSC301']), 'send me the slides')).toBe(false)
  })
})
