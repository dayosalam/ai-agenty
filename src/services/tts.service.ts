import { config } from '../core/../config.js'
import { logger } from '../core/logger.js'
import { getOpenAI } from './openai.client.js'

/** WhatsApp voice notes are Opus in an OGG container; anything else plays as a file. */
export const VOICE_MIME = 'audio/ogg; codecs=opus'

/** Roughly a minute of speech. Past this, listening is worse than reading. */
const MAX_CHARS = 900

/**
 * Turns the morning digest into a voice note.
 *
 * Used for the digest only. There is an irony to be careful with: Peermate exists
 * because nobody plays voice notes, and a test venue sent as audio cannot be
 * skimmed, searched or screenshotted. So the digest goes out as both — audio to
 * listen to on the way in, text to check when you arrive.
 */
export class TtsService {
  async speak(text: string): Promise<Buffer | null> {
    const spoken = this.forSpeech(text)
    if (!spoken) return null

    try {
      const response = await getOpenAI().audio.speech.create({
        model: config.openai.ttsModel,
        voice: config.openai.ttsVoice,
        input: spoken,
        // 'opus' comes back in an OGG container, which is exactly what ptt wants.
        response_format: 'opus',
      })
      const audio = Buffer.from(await response.arrayBuffer())
      logger.info({ chars: spoken.length, bytes: audio.length }, 'digest spoken')
      return audio
    } catch (error) {
      // The text digest has already been sent, so losing the audio costs nothing.
      logger.error({ err: error }, 'could not generate voice note')
      return null
    }
  }

  /** WhatsApp markup and citation lines are for the eye, not the ear. */
  private forSpeech(text: string): string | null {
    const spoken = text
      .replace(/_[^_]*_/g, '') // citations — a spoken timestamp helps nobody
      .replace(/[*_~`]/g, '')
      .replace(/•/g, '')
      .replace(/⏰|⚠️|✅|📎|❓|👇|🎧/g, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, '. ')
      .replace(/\s{2,}/g, ' ')
      .replace(/\.\s*\./g, '.')
      .trim()

    if (spoken.length < 10) return null
    return spoken.length > MAX_CHARS ? `${spoken.slice(0, MAX_CHARS)}…` : spoken
  }
}

export const ttsService = new TtsService()
