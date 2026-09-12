import { toFile } from 'openai'
import { config } from '../config.js'
import { TranscriptionFailed } from '../core/errors.js'
import { logger } from '../core/logger.js'
import { getOpenAI } from './openai.client.js'

/**
 * The differentiator. A 90-second lecturer voice note nobody played is the single
 * highest-value thing Peermate reads, so this path is protected: a failure here
 * keeps the audio and marks the message, it never drops the message.
 */
export class TranscriptionService {
  async transcribe(audio: Buffer, mimeType: string | null): Promise<string> {
    try {
      const file = await toFile(audio, `voice-note.${extensionFor(mimeType)}`, {
        type: mimeType ?? 'audio/ogg',
      })
      const result = await getOpenAI().audio.transcriptions.create({
        file,
        model: config.openai.transcriptionModel,
        // Left to auto-detect, Whisper hears accented Nigerian English or Pidgin as
        // another language entirely and returns fluent-looking nonsense. Pinning the
        // language is the difference between a usable transcript and gibberish.
        language: 'en',
        // Biases the decoder toward the vocabulary these recordings actually contain;
        // without it course codes come back as ordinary words.
        prompt:
          'A Nigerian university lecturer speaking to a class group chat about course codes such as CSC 301, STA 202, MAT 111, tests, assignments, deadlines, venues such as LG7 and LT2, and submission times.',
      })
      logger.debug({ chars: result.text.length }, 'transcribed')
      return result.text
    } catch (error) {
      throw new TranscriptionFailed('voice note transcription failed', error)
    }
  }
}

function extensionFor(mimeType: string | null): string {
  if (!mimeType) return 'ogg'
  // WhatsApp voice notes arrive as audio/ogg; codecs= suffixes confuse the API.
  const base = mimeType.split(';')[0] ?? ''
  return base.split('/')[1] ?? 'ogg'
}

export const transcriptionService = new TranscriptionService()
