import type { Extraction } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

/** Append-only. A venue change is a new row; history is never rewritten. */
export class ExtractionRepository extends BaseRepository<Extraction> {
  protected readonly collectionName = 'extractions'

  async insertMany(extractions: Extraction[]): Promise<string[]> {
    if (extractions.length === 0) return []
    const result = await this.collection.insertMany(extractions as never[])
    return Object.values(result.insertedIds).map(String)
  }

  async forCourses(courseKeys: string[], since: Date): Promise<Extraction[]> {
    return this.collection
      .find({ courseKey: { $in: courseKeys }, extractedAt: { $gte: since } } as never)
      .sort({ extractedAt: -1 })
      .toArray() as Promise<Extraction[]>
  }

  /**
   * An existing row describing the same event.
   *
   * Course, type and date are not enough. Matching on those alone merges two
   * assignments due the same day, two tests at different hours, and — worst —
   * every undated assignment for a course into one, because `date: null` equals
   * every other `date: null`.
   *
   * So:
   * - an undated announcement never matches; without a date there is nothing to
   *   say it is the same event rather than a new one
   * - a stated time must agree, since two tests on one day are two tests
   * - a stated venue must agree, because two venues for the same slot is a
   *   conflict the student must see, not a duplicate to fold away
   *
   * A null time or venue on either side stays open: "test Friday" and "test Friday
   * 10am" are one test described twice, and the richer version fills the gaps.
   */
  async findSimilar(candidate: Extraction): Promise<Extraction | null> {
    // Undated: unknowable, so never merged.
    if (!candidate.courseKey || !candidate.date) return null

    const agrees = (field: 'time' | 'venue'): Record<string, unknown>[] => {
      const value = candidate[field]
      // Either side may be silent; two stated values must be the same.
      return value === null
        ? [{ [field]: { $exists: true } }]
        : [{ $or: [{ [field]: value }, { [field]: null }] }]
    }

    return this.collection.findOne({
      $and: [
        { courseKey: candidate.courseKey },
        { eventType: candidate.eventType },
        { date: candidate.date },
        { eventId: { $ne: candidate.eventId } },
        ...agrees('time'),
        ...agrees('venue'),
      ],
    } as never) as Promise<Extraction | null>
  }

  /**
   * Fills in what the first telling left out.
   *
   * The append-only rule protects claims about the world: a venue that changed is
   * new information and gets its own row. A field that was simply never stated was
   * never a claim, so a later, fuller account of the same event completes it rather
   * than duplicating it. Stated values are never overwritten.
   */
  async enrich(eventId: string, from: Extraction): Promise<void> {
    // One guarded update per field, so a stated value can never be overwritten by
    // a later telling — only a silence can be filled.
    if (from.time) {
      await this.collection.updateOne({ eventId, time: null } as never, {
        $set: { time: from.time } as never,
      })
    }
    if (from.venue) {
      await this.collection.updateOne({ eventId, venue: null } as never, {
        $set: { venue: from.venue } as never,
      })
    }
  }

  async addCorroboration(eventId: string, sourceMessageId: string): Promise<void> {
    await this.collection.updateOne({ eventId } as never, {
      $addToSet: { corroboratedBy: sourceMessageId } as never,
    })
  }

  async findByEventId(eventId: string): Promise<Extraction | null> {
    return this.collection.findOne({ eventId } as never) as Promise<Extraction | null>
  }

  /**
   * Fills in a course the extractor could not determine.
   *
   * The append-only rule protects claims about the world — a venue that changed is
   * new information, not a correction. A missing course was never a claim; it was an
   * unanswered question, so answering it updates the row rather than duplicating it.
   */
  async setCourse(eventId: string, course: string, key: string | null): Promise<void> {
    await this.collection.updateOne({ eventId } as never, {
      $set: { course, courseKey: key } as never,
    })
  }

  async dueOn(courseKeys: string[], date: string): Promise<Extraction[]> {
    return this.collection
      .find({ courseKey: { $in: courseKeys }, date } as never)
      .toArray() as Promise<Extraction[]>
  }
}

export const extractionRepository = new ExtractionRepository()
