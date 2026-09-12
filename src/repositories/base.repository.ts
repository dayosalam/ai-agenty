import type { Collection, Document } from 'mongodb'
import { getDb } from '../db/mongo.js'

/**
 * Repositories own all Mongo access. Services never touch a collection directly,
 * so a change to how something is stored stays inside one file.
 */
export abstract class BaseRepository<T extends Document> {
  protected abstract readonly collectionName: string

  protected get collection(): Collection<T> {
    return getDb().collection<T>(this.collectionName)
  }
}
