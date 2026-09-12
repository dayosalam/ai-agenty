import type { PendingDecision } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export class PendingRepository extends BaseRepository<PendingDecision> {
  protected readonly collectionName = 'pending_decisions'

  async open(decision: PendingDecision): Promise<void> {
    await this.collection.updateOne(
      { eventId: decision.eventId } as never,
      { $setOnInsert: decision as never },
      { upsert: true },
    )
  }

  /** Oldest first, so answering them in order matches the order they were asked. */
  async unresolved(limit = 10): Promise<PendingDecision[]> {
    return this.collection
      .find({ status: 'open' } as never)
      .sort({ askedAt: 1 })
      .limit(limit)
      .toArray() as Promise<PendingDecision[]>
  }

  async resolve(eventId: string, course: string | null): Promise<void> {
    await this.collection.updateOne({ eventId } as never, {
      $set: {
        status: course ? 'resolved' : 'ignored',
        resolvedAt: new Date(),
        resolvedCourse: course,
      } as never,
    })
  }

  /** Everything still open from one group — answered together when the group is set. */
  async openForGroup(chatJid: string): Promise<PendingDecision[]> {
    return this.collection.find({ chatJid, status: 'open' } as never).toArray() as Promise<
      PendingDecision[]
    >
  }
}

export const pendingRepository = new PendingRepository()
