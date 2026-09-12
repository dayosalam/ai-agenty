import { z } from 'zod'

export const NotificationType = z.enum(['instant', 'digest', 'deadline_warning'])
export type NotificationType = z.infer<typeof NotificationType>

export const NotificationSchema = z.object({
  userPhone: z.string(),
  extractionId: z.string().nullable(),
  notificationType: NotificationType,
  status: z.enum(['sent', 'failed']),
  error: z.string().nullable().default(null),
  sentAt: z.date(),
})
export type Notification = z.infer<typeof NotificationSchema>
