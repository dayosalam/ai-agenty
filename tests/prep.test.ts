import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Quiz } from '../src/models/index.js'
import type { Candidate } from '../src/services/retrieval.service.js'

let material: Candidate[] = []
let parsed: unknown = null
const prompts: string[] = []
const searches: Array<{ query: string }> = []
let searchResults: Array<{ title: string; url: string; text: string }> = []
let exaKey = ''

vi.mock('../src/services/retrieval.service.js', () => ({
  retrievalService: { material: vi.fn(async () => material) },
}))

vi.mock('../src/config.js', () => ({
  config: {
    logLevel: 'silent',
    isProduction: false,
    openai: { answerModel: 'gpt-4o' },
    get research() {
      return {
        apiKey: exaKey,
        enabled: exaKey !== '',
        resultsPerTopic: 2,
        topicsResearched: 3,
        maxCharacters: 600,
        timeoutMs: 6000,
      }
    },
  },
}))

vi.mock('../src/services/openai.client.js', () => ({
  getOpenAI: () => ({
    beta: {
      chat: {
        completions: {
          parse: vi.fn(async (request: { messages: Array<{ content: string }> }) => {
            prompts.push(request.messages.map((message) => message.content).join('\n'))
            return { choices: [{ message: { parsed } }] }
          }),
        },
      },
    },
  }),
}))

vi.stubGlobal(
  'fetch',
  vi.fn(async (_url: string, init: { body: string }) => {
    searches.push(JSON.parse(init.body) as { query: string })
    return { ok: true, json: async () => ({ results: searchResults }) }
  }),
)

const { prepService } = await import('../src/services/prep.service.js')
const { researchService } = await import('../src/services/research.service.js')

function chunk(over: Partial<Candidate>): Candidate {
  return {
    waMessageId: 'm1',
    content: 'Shear force is the internal force acting perpendicular to the member axis.',
    senderName: 'Class rep',
    type: 'document',
    timestamp: new Date(),
    courseKey: 'CVE575',
    sourceKind: 'document',
    fileName: 'CVE575-notes.pdf',
    page: 4,
    readVia: 'text',
    ...over,
  }
}

const BUILT = {
  topics: ['shear force diagrams', 'bending moments', 'support reactions'],
  questions: [
    {
      question: 'Define shear force.',
      answer: 'The internal force perpendicular to the axis.',
      source: 'CVE575-notes.pdf, p.4',
    },
    {
      question: 'State two types of support.',
      answer: 'Pinned and roller.',
      source: 'CVE575-notes.pdf, p.6',
    },
  ],
}

beforeEach(() => {
  material = []
  parsed = BUILT
  prompts.length = 0
  searches.length = 0
  searchResults = []
  exaKey = ''
})

/**
 * Revision has to come from the lecturer's own material. A model asked to prepare
 * somebody for "CVE 575" writes a plausible syllabus out of its own memory, and the
 * student revises confidently for an exam nobody is setting.
 */
describe('building a practice set', () => {
  it('refuses to invent one when no files have been shared', async () => {
    expect(await prepService.brief({ phone: '234' } as never, 'CVE575')).toBeNull()
  })

  /** Holding a file it cannot open is not the same as having material. */
  it('refuses when the only files are ones it could not read', async () => {
    material = [chunk({ readVia: 'none', content: 'Shared file: scan.pdf' })]
    expect(await prepService.brief({ phone: '234' } as never, 'CVE575')).toBeNull()
  })

  it('lists the topics and the questions, and says where they came from', async () => {
    material = [chunk({}), chunk({ fileName: 'CVE575-past-questions.pdf', page: 1 })]

    const built = await prepService.brief({ phone: '234' } as never, 'CVE575')
    expect(built!.text).toMatch(/Prep for CVE 575/)
    expect(built!.text).toMatch(/From 2 files shared/)
    expect(built!.text).toMatch(/shear force diagrams/)
    expect(built!.text).toMatch(/1\. Define shear force\./)
    expect(built!.text).toMatch(/quiz me/i)
    expect(built!.quiz.questions).toHaveLength(2)
  })

  it('admits to the files it is holding but could not read', async () => {
    material = [chunk({}), chunk({ fileName: 'scan.pdf', readVia: 'none' })]

    const built = await prepService.brief({ phone: '234' } as never, 'CVE575')
    expect(built!.text).toMatch(/couldn't read \(scan\.pdf\)/)
  })

  /** The past paper is what the test looks like; the model must see it first. */
  it('puts past questions in front of the notes', async () => {
    material = [
      ...Array.from({ length: 50 }, () => chunk({ content: 'notes filler' })),
      chunk({ fileName: '2024-past-questions.pdf', content: 'Question 1: derive the reaction.' }),
    ]

    await prepService.brief({ phone: '234' } as never, 'CVE575')
    expect(prompts[0]).toMatch(/derive the reaction/)
  })
})

/**
 * Exa widens the explanation, never the syllabus. A search run on the student's own
 * question, or one whose results became quiz questions, would be preparing them for
 * whatever the internet finds interesting instead of for their course.
 */
describe('further reading', () => {
  beforeEach(() => {
    exaKey = 'test-key'
    searchResults = [
      {
        title: 'Shear force diagrams explained',
        url: 'https://example.edu/shear',
        text: 'A shear force diagram shows how the internal shear varies along a beam under load.',
      },
    ]
  })

  it('searches only the topics the files raised, framed by the course', async () => {
    material = [chunk({})]
    await prepService.brief({ phone: '234' } as never, 'CVE575')

    expect(searches).toHaveLength(3)
    expect(searches.map((search) => search.query).join(' ')).toMatch(/shear force diagrams/)
    expect(searches[0]!.query).toMatch(/CVE 575/)
  })

  it('labels the links as web material, apart from the files', async () => {
    material = [chunk({})]
    const built = await prepService.brief({ phone: '234' } as never, 'CVE575')

    expect(built!.text).toMatch(/Going deeper.*not from your files/)
    expect(built!.text).toMatch(/https:\/\/example\.edu\/shear/)
  })

  /** A link is not a question. Nothing from the web is ever marked as an answer. */
  it('never turns a search result into a quiz question', async () => {
    material = [chunk({})]
    const built = await prepService.brief({ phone: '234' } as never, 'CVE575')

    expect(built!.quiz.questions.map((question) => question.question)).toEqual([
      'Define shear force.',
      'State two types of support.',
    ])
  })

  it('is simply absent when no key is configured', async () => {
    exaKey = ''
    material = [chunk({})]

    const built = await prepService.brief({ phone: '234' } as never, 'CVE575')
    expect(searches).toHaveLength(0)
    expect(built!.text).not.toMatch(/Going deeper/)
  })

  it('still builds the prep when the search fails', async () => {
    material = [chunk({})]
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network'))

    const built = await prepService.brief({ phone: '234' } as never, 'CVE575')
    expect(built!.text).toMatch(/Prep for CVE 575/)
  })
})

/**
 * A course code is a local invention. "CVE 575" means nothing outside the university
 * that issued it, and searching on it returned a Math 575 review sheet for a
 * transportation engineering course — not a near miss, a different subject, and one
 * the student cannot spot before opening the file.
 */
describe('finding material outside the group', () => {
  beforeEach(() => {
    exaKey = 'test-key'
  })

  it('searches the subject, not the course number', async () => {
    searchResults = []
    await researchService.documentsFor({
      code: 'CVE 575',
      title: 'Transportation Engineering',
      words: '',
    })

    expect(searches[0]!.query).toMatch(/Transportation Engineering/)
    expect(searches[0]!.query).not.toMatch(/575/)
  })

  it('drops a result that is about a different subject entirely', async () => {
    searchResults = [
      {
        title: 'Math 575 Final Review Sheet',
        url: 'https://example.edu/math575.pdf',
        text: 'infinite sequences and series, topology of the real numbers',
      },
      {
        title: 'Transportation Engineering question bank',
        url: 'https://example.edu/te.pdf',
        text: 'highway geometric design, traffic flow',
      },
    ]

    const found = await researchService.documentsFor({
      code: 'CVE 575',
      title: 'Transportation Engineering',
      words: '',
    })

    expect(found.map((item) => item.title)).toEqual(['Transportation Engineering question bank'])
  })

  it('keeps everything when it has no subject to judge against', async () => {
    searchResults = [
      { title: 'Math 575 Final Review', url: 'https://example.edu/m.pdf', text: 'sequences' },
    ]

    const found = await researchService.documentsFor({ code: 'CVE 575', title: null, words: '' })
    expect(found).toHaveLength(1)
  })

  it('leaves out what it has already offered', async () => {
    searchResults = [
      { title: 'Traffic flow notes', url: 'https://example.edu/a.pdf', text: 'traffic' },
      { title: 'Highway design notes', url: 'https://example.edu/b.pdf', text: 'highway' },
    ]

    const found = await researchService.documentsFor(
      { code: 'CVE 575', title: 'Transportation Engineering', words: 'traffic highway' },
      ['https://example.edu/a.pdf'],
    )

    expect(found.map((item) => item.url)).toEqual(['https://example.edu/b.pdf'])
  })

  it('offers only what it can actually send', async () => {
    searchResults = [
      { title: 'Traffic flow lecture', url: 'https://example.edu/page.html', text: 'traffic' },
    ]

    const found = await researchService.documentsFor({
      code: 'CVE 575',
      title: 'Transportation Engineering',
      words: 'traffic',
    })
    expect(found).toHaveLength(0)
  })
})

describe('being quizzed', () => {
  const quiz = (): Quiz => ({ courseKey: 'CVE575', questions: BUILT.questions, index: 0, right: 0 })

  it('asks one at a time, numbered', async () => {
    const asked = prepService.ask(quiz())
    expect(asked).toMatch(/question 1 of 2/)
    expect(asked).toMatch(/Define shear force\./)
    expect(asked).not.toMatch(/State two types/)
  })

  /**
   * The answer is shown either way. "Wrong" on its own teaches nothing, and somebody
   * revising alone at 1am has nowhere else to look it up.
   */
  it('shows the right answer even when they got it right', async () => {
    parsed = { verdict: 'right', comment: 'Exactly that.' }

    const { reply, next } = await prepService.mark(quiz(), 'force perpendicular to the axis')
    expect(reply).toMatch(/Right/)
    expect(reply).toMatch(/\*Answer:\* The internal force perpendicular to the axis\./)
    expect(reply).toMatch(/CVE575-notes\.pdf, p\.4/)
    expect(next.right).toBe(1)
    // And rolls straight on.
    expect(reply).toMatch(/question 2 of 2/)
  })

  it('marks a wrong answer without scoring it', async () => {
    parsed = { verdict: 'wrong', comment: 'That is the bending moment, not the shear force.' }

    const { reply, next } = await prepService.mark(quiz(), 'the moment about the support')
    expect(reply).toMatch(/Not quite/)
    expect(reply).toMatch(/bending moment/)
    expect(next.right).toBe(0)
  })

  /** "I don't know" is an answer to mark generously, not an error to charge for. */
  it('takes a skip without calling the model', async () => {
    prompts.length = 0
    const { reply, next } = await prepService.mark(quiz(), 'idk')

    expect(prompts).toHaveLength(0)
    expect(reply).toMatch(/Skipped/)
    expect(reply).toMatch(/\*Answer:\*/)
    expect(next.index).toBe(1)
  })

  it('ends with the score', async () => {
    parsed = { verdict: 'right', comment: 'Yes.' }
    const last: Quiz = { courseKey: 'CVE575', questions: BUILT.questions, index: 1, right: 1 }

    const { reply } = await prepService.mark(last, 'pinned and roller')
    expect(reply).toMatch(/Done — 2 of 2 right/)
  })

  it('says nothing was asked when they stop before answering anything', () => {
    expect(prepService.score(quiz())).toMatch(/Stopped/)
  })
})
