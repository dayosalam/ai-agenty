import type { Notification, NotificationType } from '../models/index.js'
import { BaseRepository } from './base.repository.js'

export class NotificationRepository extends BaseRepository<Notification> {
  protected readonly collectionName = 'notifications'

  async log(notification: Notification): Promise<void> {
    await this.collection.insertOne(notification as never)
  }

  /**
   * Has this student already been told about this event today?
   *
   * The scheduler can fire twice — a restart mid-job, a manual run, a container
   * replacement — and without this the student gets the same deadline warning and
   * the same attached brief again.
   */
  async alreadySent(
    userPhone: string,
    extractionId: string,
    notificationType: NotificationType,
    since: Date,
  ): Promise<boolean> {
    const existing = await this.collection.findOne({
      userPhone,
      extractionId,
      notificationType,
      status: 'sent',
      sentAt: { $gte: since },
    } as never)
    return existing !== null
  }
}

export const notificationRepository = new NotificationRepository()
