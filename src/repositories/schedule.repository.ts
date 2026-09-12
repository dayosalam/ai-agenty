import type { ScheduleEntry } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export class ScheduleRepository extends BaseRepository<ScheduleEntry> {
  protected readonly collectionName = 'schedules'

  async insertMany(entries: ScheduleEntry[]): Promise<void> {
    if (entries.length === 0) return
    await this.collection.insertMany(entries as never[])
  }

  async forStudent(phone: string): Promise<ScheduleEntry[]> {
    return this.collection.find({ phone } as never).toArray() as Promise<ScheduleEntry[]>
  }

  async forCourse(phone: string, courseKey: string): Promise<ScheduleEntry[]> {
    return this.collection.find({ phone, courseKey } as never).toArray() as Promise<ScheduleEntry[]>
  }

  /**
   * Replaces a previous upload of the same kind.
   *
   * People re-send a timetable when it changes, and keeping both leaves the student
   * reminded of an exam that moved. The photograph itself is still stored, so the
   * superseded version is recoverable from `messages`.
   */
  async replaceKinds(phone: string, kinds: string[]): Promise<number> {
    if (kinds.length === 0) return 0
    const { deletedCount } = await this.collection.deleteMany({
      phone,
      kind: { $in: kinds },
    } as never)
    return deletedCount
  }

  /**
   * Applies a correction the student made in words.
   *
   * Theirs to change: unlike an extraction, which is a claim about what somebody
   * said, this row is the student's own record of their own week. Updating it in
   * place is the honest model — there is nobody else's account to preserve.
   */
  async amend(
    phone: string,
    courseKey: string,
    kind: string | null,
    patch: { time?: string; venue?: string; date?: string; weekday?: number },
  ): Promise<number> {
    const filter: Record<string, unknown> = { phone, courseKey }
    if (kind) filter.kind = kind

    const { modifiedCount } = await this.collection.updateMany(filter as never, {
      $set: patch as never,
    })
    return modifiedCount
  }

  async remove(phone: string, courseKey: string, kind: string | null): Promise<number> {
    const filter: Record<string, unknown> = { phone, courseKey }
    if (kind) filter.kind = kind
    const { deletedCount } = await this.collection.deleteMany(filter as never)
    return deletedCount
  }

  async clear(phone: string): Promise<void> {
    await this.collection.deleteMany({ phone } as never)
  }
}

export const scheduleRepository = new ScheduleRepository()
