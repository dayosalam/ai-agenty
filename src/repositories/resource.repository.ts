import type { Resource } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export class ResourceRepository extends BaseRepository<Resource> {
  protected readonly collectionName = 'resources'

  async insert(resource: Resource): Promise<void> {
    await this.collection.insertOne(resource as never)
  }

  async forCourse(courseKey: string): Promise<Resource[]> {
    return this.collection
      .find({ courseKey } as never)
      .sort({ postedAt: -1 })
      .toArray() as Promise<Resource[]>
  }
}

export const resourceRepository = new ResourceRepository()
