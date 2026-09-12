import { config } from '../config.js'
import { getOpenAI } from './openai.client.js'

export class EmbeddingService {
  async embed(text: string): Promise<number[]> {
    const [first] = await this.embedAll([text])
    return first ?? []
  }

  async embedAll(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const response = await getOpenAI().embeddings.create({
      model: config.embeddings.model,
      input: texts,
    })
    return response.data.map((item) => item.embedding)
  }
}

export const embeddingService = new EmbeddingService()
