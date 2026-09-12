import OpenAI from 'openai'
import { config } from '../config.js'

let client: OpenAI | null = null

export function getOpenAI(): OpenAI {
  if (!config.openai.apiKey) {
    throw new Error('OPENAI_API_KEY is not set — transcription, extraction and Q&A cannot run')
  }
  client ??= new OpenAI({ apiKey: config.openai.apiKey })
  return client
}
