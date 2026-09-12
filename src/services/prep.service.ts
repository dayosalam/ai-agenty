import { zodResponseFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { Quiz, QuizQuestion, User } from '../models/index.js'
import { courseDisplay } from '../utils/courses.js'
import { getOpenAI } from './openai.client.js'
import { researchService, type Reading } from './research.service.js'
import { retrievalService, type Candidate } from './retrieval.service.js'

/** Past questions are what a test actually looks like, so they lead the material. */
const PAST_QUESTION_HINT = /past|pq|exam|question|paper|test/i

/**
 * Enough of the material to cover a course without burying the model. Chunks are
 * sampled across files rather than taken in order — the first forty chunks of a
 * hundred-page slide deck are the introduction, which is not what a test is about.
 */
const CHUNKS_USED = 40

const PrepSchema = z.object({
  /** What the material actually covers, in the student's own syllabus terms. */
  topics: z.array(z.string()),
  questions: z.array(
    z.object({
      question: z.string(),
      /** Short enough to read on a phone — two or three lines. */
      answer: z.string(),
      /** "CVE575-lecture3.pdf, p.4". Null when it came from across several places. */
      source: z.string().nullable(),
    }),
  ),
})

const MarkSchema = z.object({
  verdict: z.enum(['right', 'close', 'wrong']),
  /** One or two lines: what was missing, or what they got right. */
  comment: z.string(),
})

const SYSTEM = `You prepare a Nigerian university student for a test, using ONLY the course material provided.

Rules:
- Every question and every answer must be answerable from the provided material. Never test them on something that is not in it.
- Prefer what looks like a past question paper: those are what the real test looks like. Otherwise build questions from the headings, definitions and worked examples in the notes.
- Write questions the way a lecturer in this course would write them — "Define...", "State two...", "Derive...", "With a diagram, explain..." — not multiple choice unless the material itself is multiple choice.
- Keep each answer to two or three lines. This is revision on a phone, not a textbook.
- Cite the file and page an answer came from, exactly as given in the excerpt header.
- If the material is thin, return fewer questions rather than inventing more. Six good questions beat twelve guesses.
- Topics are what the material covers, in the student's own words — "shear force diagrams", "soil classification" — never "Chapter 3".`

const MARK_SYSTEM = `You mark one short answer from a university student, generously but honestly.

- "right" means they have the substance, even if the wording is loose or the spelling is wrong.
- "close" means they have part of it or the right idea with a real gap.
- "wrong" means they have not got it, or they said they do not know.
- The comment is one or two lines, spoken to them directly. Say what was missing. Never be sarcastic and never pad it with praise they did not earn.`

/**
 * Revision built from the files people actually shared.
 *
 * Peermate already holds the slides and past papers — they are read, chunked and
 * indexed for answering questions. The same material answers a bigger one: "am I
 * ready?". Nothing here invents content; a course with no files gets told so.
 */
export class PrepService {
  /**
   * A study brief: what the material covers, and questions likely to be asked.
   *
   * Returns null when there is nothing to build it from, so the caller can say what
   * is missing rather than produce a confident-looking page of invented questions.
   */
  async brief(user: User, courseKey: string): Promise<{ text: string; quiz: Quiz } | null> {
    const material = await retrievalService.material(courseKey)
    const readable = material.filter((chunk) => chunk.readVia !== 'none')
    if (readable.length === 0) return null

    const prep = await this.build(readable, courseKey)
    if (!prep || prep.questions.length === 0) return null

    const course = courseDisplay(courseKey) ?? courseKey
    // Only the topics the files themselves raised are ever searched. The web widens
    // the explanation of what is on the syllabus; it must not widen the syllabus.
    const reading = await researchService.readingFor(prep.topics, course)
    const files = new Set(readable.map((chunk) => chunk.fileName).filter(Boolean))
    const unreadable = material.filter((chunk) => chunk.readVia === 'none')

    const lines = [
      `📚 *Prep for ${course}*`,
      `_From ${files.size} file${files.size === 1 ? '' : 's'} shared in your group._`,
      '',
      '*What the material covers*',
      ...prep.topics.slice(0, 8).map((topic) => `• ${topic}`),
      '',
      '*Likely questions*',
      ...prep.questions.map((item, index) => `${index + 1}. ${item.question}`),
    ]

    if (reading.length > 0) {
      lines.push('', '*Going deeper* _(from the web, not from your files)_', ...describe(reading))
    }

    if (unreadable.length > 0) {
      const names = [...new Set(unreadable.map((chunk) => chunk.fileName).filter(Boolean))]
      lines.push(
        '',
        `_I'm also holding ${names.length} file${names.length === 1 ? '' : 's'} I couldn't read (${names.join(', ')}) — ask and I'll send ${names.length === 1 ? 'it' : 'them'} over._`,
      )
    }

    lines.push('', `Send *quiz me* and I'll ask them one at a time and mark your answers.`)

    return {
      text: lines.join('\n'),
      quiz: { courseKey, questions: prep.questions, index: 0, right: 0 },
    }
  }

  /** The first question, once they have said they want to be asked. */
  ask(quiz: Quiz): string {
    const current = quiz.questions[quiz.index]
    if (!current) return this.score(quiz)

    const course = courseDisplay(quiz.courseKey) ?? quiz.courseKey
    return `*${course} — question ${quiz.index + 1} of ${quiz.questions.length}*

${current.question}

_Type your answer, or *skip*. Send *stop* to end._`
  }

  /**
   * Marks an answer and moves on.
   *
   * The right answer is shown either way. Being told only "wrong" is the one outcome
   * that teaches nothing, and a student revising alone has nowhere else to look.
   */
  async mark(quiz: Quiz, said: string): Promise<{ reply: string; next: Quiz }> {
    const current = quiz.questions[quiz.index]
    if (!current) return { reply: this.score(quiz), next: quiz }

    const skipped = /^(skip|next|pass|i don'?t know|idk|dunno)\b/i.test(said.trim())
    const verdict = skipped ? null : await this.judge(current, said)

    const next: Quiz = {
      ...quiz,
      index: quiz.index + 1,
      right: quiz.right + (verdict?.verdict === 'right' ? 1 : 0),
    }

    const head = skipped
      ? '⏭️ *Skipped*'
      : verdict?.verdict === 'right'
        ? '✅ *Right*'
        : verdict?.verdict === 'close'
          ? '🟡 *Close*'
          : '❌ *Not quite*'

    const body = [
      head,
      verdict?.comment ?? '',
      '',
      `*Answer:* ${current.answer}`,
      current.source ? `_${current.source}_` : '',
    ]
      .filter(Boolean)
      .join('\n')

    const more =
      next.index < next.questions.length
        ? `\n\n———\n\n${this.ask(next)}`
        : `\n\n${this.score(next)}`
    return { reply: `${body}${more}`, next }
  }

  /** How it went, said plainly. A score nobody asked for is still the point of a quiz. */
  score(quiz: Quiz): string {
    const asked = Math.min(quiz.index, quiz.questions.length)
    const course = courseDisplay(quiz.courseKey) ?? quiz.courseKey
    if (asked === 0)
      return `Stopped. Send *prep me for ${course}* whenever you want to pick it up again.`

    return `*Done — ${quiz.right} of ${asked} right.*

${quiz.right === asked ? "That's the lot. You're ready." : "Go back over the ones you missed — ask me for the files and I'll send them."}`
  }

  private async build(
    material: Candidate[],
    courseKey: string,
  ): Promise<z.infer<typeof PrepSchema> | null> {
    try {
      const completion = await getOpenAI().beta.chat.completions.parse({
        model: config.openai.answerModel,
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: `Course: ${courseDisplay(courseKey) ?? courseKey}

Build 6 to 8 questions.

Material:
${format(sample(material))}`,
          },
        ],
        response_format: zodResponseFormat(PrepSchema, 'prep'),
      })
      return completion.choices[0]?.message.parsed ?? null
    } catch (error) {
      logger.error({ err: error, courseKey }, 'could not build prep')
      return null
    }
  }

  private async judge(
    question: QuizQuestion,
    said: string,
  ): Promise<z.infer<typeof MarkSchema> | null> {
    try {
      const completion = await getOpenAI().beta.chat.completions.parse({
        model: config.openai.answerModel,
        messages: [
          { role: 'system', content: MARK_SYSTEM },
          {
            role: 'user',
            content: `Question: ${question.question}\nCorrect answer: ${question.answer}\nWhat they said: ${said}`,
          },
        ],
        response_format: zodResponseFormat(MarkSchema, 'mark'),
      })
      return completion.choices[0]?.message.parsed ?? null
    } catch (error) {
      logger.error({ err: error }, 'could not mark answer')
      return null
    }
  }
}

/**
 * Spreads the sample across the files, past papers first.
 *
 * Taking the first N chunks gives the model one file's opening pages, which is how a
 * whole revision set ends up being about the course outline.
 */
function sample(material: Candidate[]): Candidate[] {
  const byFile = new Map<string, Candidate[]>()
  for (const chunk of material) {
    const key = chunk.fileName ?? 'unknown'
    byFile.set(key, [...(byFile.get(key) ?? []), chunk])
  }

  const files = [...byFile.entries()].sort(
    (a, b) => Number(PAST_QUESTION_HINT.test(b[0])) - Number(PAST_QUESTION_HINT.test(a[0])),
  )

  const picked: Candidate[] = []
  let round = 0
  while (picked.length < CHUNKS_USED) {
    const taken = picked.length
    for (const [, chunks] of files) {
      const chunk = chunks[round]
      if (chunk) picked.push(chunk)
      if (picked.length >= CHUNKS_USED) break
    }
    if (picked.length === taken) break
    round += 1
  }
  return picked
}

/**
 * The reading list, grouped by the topic that prompted it.
 *
 * Marked as web material throughout. A student revising has to know which lines came
 * from their lecturer's notes and which came from a stranger's blog, because only one
 * of those is what they will be tested on.
 */
function describe(reading: Reading[]): string[] {
  const byTopic = new Map<string, Reading[]>()
  for (const item of reading) byTopic.set(item.topic, [...(byTopic.get(item.topic) ?? []), item])

  return [...byTopic].flatMap(([topic, items]) => [
    `_${topic}_`,
    ...items.map((item) => `• ${item.title}\n  ${item.url}`),
  ])
}

function format(material: Candidate[]): string {
  return material
    .map(
      (chunk) =>
        `[${chunk.fileName ?? 'shared file'}${chunk.page ? `, p.${chunk.page}` : ''}]\n${chunk.content}`,
    )
    .join('\n\n')
}

export const prepService = new PrepService()
