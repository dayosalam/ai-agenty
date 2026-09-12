import type { Conversation } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export class ConversationRepository extends BaseRepository<Conversation> {
  protected readonly collectionName = 'conversations'

  async find(phone: string): Promise<Conversation | null> {
    return this.collection.findOne({ phone } as never) as Promise<Conversation | null>
  }

  async save(conversation: Conversation): Promise<void> {
    await this.collection.updateOne(
      { phone: conversation.phone } as never,
      { $set: conversation as never },
      { upsert: true },
    )
  }

  async clear(phone: string): Promise<void> {
    await this.collection.deleteOne({ phone } as never)
  }
}

export const conversationRepository = new ConversationRepository()
