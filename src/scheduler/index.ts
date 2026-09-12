import cron from 'node-cron'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { deadlineService } from '../services/deadline.service.js'
import { digestService } from '../services/digest.service.js'
import { reminderService } from '../services/reminder.service.js'
import { hourIn } from '../utils/quiet.js'

/**
 * One cron, three jobs, Africa/Lagos.
 *
 * Reminders need a quarter-hour cadence — a 45-minute warning for a 10am lecture
 * cannot wait for the top of the hour — while the digest must go out exactly once, at
 * whichever hour each student chose. So the tick is fine-grained and the hourly work
 * is gated to the first quarter of each hour.
 */
export function startScheduler(): void {
  // Every quarter hour. The digest still goes out once, at the hour a student chose,
  // but a reminder for a 10am lecture cannot wait for the top of the hour.
  const expression = '*/15 * * * *'

  cron.schedule(
    expression,
    () => {
      void (async () => {
        try {
          // First, because they are the time-critical half: a slow digest run must
          // not push a 45-minute warning past the thing it warns about.
          await reminderService.run()

          if (new Date().getMinutes() >= 15) return

          const hour = hourIn(config.digest.timezone)
          await digestService.runForHour(hour)
          // The digest already listed everything due today, so the deadline pass runs
          // after it and sends only the attachments — a due assignment is named once
          // rather than announced twice seconds apart. Default hour only: nobody
          // wants an attachment at an hour they did not ask for.
          if (hour === config.digest.hour) {
            await deadlineService.runForAll({ attachmentsOnly: true })
          }
        } catch (error) {
          logger.error({ err: error }, 'scheduled run failed')
        }
      })()
    },
    { timezone: config.digest.timezone },
  )

  logger.info({ at: expression, timezone: config.digest.timezone }, 'scheduler started')
}
