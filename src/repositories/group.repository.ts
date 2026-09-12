import type { Group } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export class GroupRepository extends BaseRepository<Group> {
  protected readonly collectionName = 'groups'

  async findByJid(chatJid: string): Promise<Group | null> {
    return this.collection.findOne({ chatJid } as never) as Promise<Group | null>
  }

  async upsert(group: Group): Promise<void> {
    await this.collection.updateOne(
      { chatJid: group.chatJid } as never,
      { $set: group as never },
      {
        upsert: true,
      },
    )
  }

  /** Only approved groups count as coverage — see PRD §7. */
  async approved(): Promise<Group[]> {
    return this.collection.find({ status: 'approved' } as never).toArray() as Promise<Group[]>
  }

  async pending(): Promise<Group[]> {
    return this.collection.find({ status: 'pending' } as never).toArray() as Promise<Group[]>
  }

  async all(): Promise<Group[]> {
    return this.collection.find({}).toArray() as Promise<Group[]>
  }
}

export const groupRepository = new GroupRepository()
