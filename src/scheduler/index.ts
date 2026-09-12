import cron from 'node-cron'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { deadlineService } from '../services/deadline.service.js'
import { digestService } from '../services/digest.service.js'
import { hourIn } from '../utils/quiet.js'

/**
 * 07:00 Africa/Lagos, both jobs.
 *
 * The digest runs first so a student reading top-to-bottom sees the day's overview
 * before the individual deadline warning with its attachment.
 */
export function startScheduler(): void {
  // Hourly, because students choose their own digest hour. Each run sends only to
  // the people who asked for this one.
  const expression = `${config.digest.minute} * * * *`

  cron.schedule(
    expression,
    () => {
      void (async () => {
        try {
          // The digest already lists everything due today. The deadline pass runs
          // after it and sends only the attachments, so a due assignment is named
          // once rather than announced twice seconds apart.
          const hour = hourIn(config.digest.timezone)
          await digestService.runForHour(hour)
          // Deadline warnings follow the default hour only; they attach files, and
          // nobody wants an attachment at an hour they did not ask for.
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
