import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { getOpenAI } from './openai.client.js'

const NO_TEXT = 'NO TEXT'

/**
 * Two framings of the same request.
 *
 * The first is what we want: a faithful reading. But gpt-4o intermittently refuses
 * prompts shaped like "transcribe the text in this image" — a document-transcription
 * guardrail — and a refusal reads as an empty result, silently losing a timetable.
 * The second framing describes the actual situation instead and is not refused, so
 * it is used as a retry.
 */
const PROMPTS = [
  `Read this image and write out everything it says, as plain text.

It is most likely a photographed university timetable, noticeboard, or handwritten note. Preserve course codes, dates, times and venues exactly as written, including the table layout if there is one. Do not summarise, interpret, or add anything that is not visibly written. If nothing is legible, reply with exactly: ${NO_TEXT}`,

  `A student shared this photo in their university course group chat and a classmate who cannot open it needs to know what it says.

Write out every piece of information visible: course codes, days, dates, times, venues, and any note at the bottom. Keep the rows in the order they appear. Report only what is actually visible — if you cannot make out the content, reply with exactly: ${NO_TEXT}`,
]

const REFUSAL = /\b(I'?m sorry|I can'?t|I cannot|I am unable|unable to)\b/i

/**
 * OCR for photographed timetables. Deliberately reading, not interpretation —
 * ExtractionService is the only thing allowed to decide what an announcement says,
 * and it works from text.
 */
export class VisionService {
  async readImage(image: Buffer, mimeType: string | null): Promise<string | null> {
    const dataUrl = `data:${mimeType ?? 'image/jpeg'};base64,${image.toString('base64')}`

    for (const [attempt, prompt] of PROMPTS.entries()) {
      const text = await this.ask(prompt, dataUrl)

      if (text && !REFUSAL.test(text)) {
        logger.debug({ chars: text.length, attempt }, 'image read')
        return text
      }

      if (text && REFUSAL.test(text)) {
        // A refusal is not an empty image. Retrying with the other framing is the
        // difference between filing a timetable and silently dropping it.
        logger.warn({ attempt, reply: text.slice(0, 80) }, 'vision refused, retrying')
        continue
      }

      return null
    }

    logger.error('vision refused both framings; image not read')
    return null
  }

  private async ask(prompt: string, dataUrl: string): Promise<string | null> {
    const completion = await getOpenAI().chat.completions.create({
      model: config.openai.visionModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            // Small text on a photographed page is unreadable at default detail.
            { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } },
          ],
        },
      ],
    })
    const text = completion.choices[0]?.message.content?.trim() ?? ''
    if (!text || text === NO_TEXT) return null
    return text
  }
}

export const visionService = new VisionService()
