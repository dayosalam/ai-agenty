import type { OnboardingState, User } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

/**
 * Fields added after a student registered are absent from their stored document,
 * and `undefined.includes` throws inside the delivery gate — which would take the
 * whole announcement loop down for everyone who registered before the change.
 */
function withDefaults(user: User | null): User | null {
  if (!user) return null
  return {
    ...user,
    pausedUntil: user.pausedUntil ?? null,
    paused: user.paused ?? false,
    digestPaused: user.digestPaused ?? false,
    alertLevel: user.alertLevel ?? 'all',
    mutedCourseKeys: user.mutedCourseKeys ?? [],
  }
}

export class UserRepository extends BaseRepository<User> {
  protected readonly collectionName = 'users'

  async findByPhone(phone: string): Promise<User | null> {
    const found = (await this.collection.findOne({ phone } as never)) as User | null
    return withDefaults(found)
  }

  async upsert(user: User): Promise<void> {
    await this.collection.updateOne(
      { phone: user.phone } as never,
      { $set: user as never },
      {
        upsert: true,
      },
    )
  }

  async setState(phone: string, onboardingState: OnboardingState): Promise<void> {
    await this.collection.updateOne({ phone } as never, { $set: { onboardingState } as never })
  }

  /** Everyone subscribed to a course — the audience for an instant announcement DM. */
  async subscribedTo(courseKey: string): Promise<User[]> {
    const found = (await this.collection
      .find({ courseKeys: courseKey, onboardingState: 'registered' } as never)
      .toArray()) as User[]
    return found.map((user) => withDefaults(user)!)
  }

  /** Students whose chosen digest hour is now. */
  async dueForDigest(hour: number): Promise<User[]> {
    const found = (await this.collection
      .find({ onboardingState: 'registered', digestHour: hour } as never)
      .toArray()) as User[]
    return found.map((user) => withDefaults(user)!)
  }

  async allRegistered(): Promise<User[]> {
    const found = (await this.collection
      .find({ onboardingState: 'registered' } as never)
      .toArray()) as User[]
    return found.map((user) => withDefaults(user)!)
  }
}

export const userRepository = new UserRepository()
