import type { Course } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export class CourseRepository extends BaseRepository<Course> {
  protected readonly collectionName = 'courses'

  async find(courseKey: string): Promise<Course | null> {
    return this.collection.findOne({ courseKey } as never) as Promise<Course | null>
  }

  async all(): Promise<Course[]> {
    return this.collection.find({} as never).toArray() as Promise<Course[]>
  }

  async forKeys(courseKeys: string[]): Promise<Course[]> {
    return this.collection.find({ courseKey: { $in: courseKeys } } as never).toArray() as Promise<
      Course[]
    >
  }

  /**
   * Merges rather than overwrites.
   *
   * Facts arrive from different places at different times — a title from a
   * photographed timetable, a lecturer from a group's trusted senders — and a later
   * source that happens to know less must not erase what an earlier one knew.
   */
  async enrich(courseKey: string, patch: Partial<Course>): Promise<void> {
    const existing = await this.find(courseKey)
    const aliases = [...new Set([...(existing?.aliases ?? []), ...(patch.aliases ?? [])])]

    await this.collection.updateOne(
      { courseKey } as never,
      {
        $set: {
          courseKey,
          code: patch.code ?? existing?.code ?? courseKey,
          title: patch.title ?? existing?.title ?? null,
          lecturer: patch.lecturer ?? existing?.lecturer ?? null,
          aliases,
          updatedAt: new Date(),
        } as never,
      },
      { upsert: true },
    )
  }
}

export const courseRepository = new CourseRepository()
