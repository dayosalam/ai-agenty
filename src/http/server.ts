import express, { type Express } from 'express'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { groupRepository } from '../repositories/index.js'
import { ingestQueue } from '../workers/ingest.worker.js'

/**
 * Deliberately small. With Baileys in-process there is no inbound webhook, so this
 * exists only for health checks and operator tasks — never for student-facing flows,
 * which all happen in WhatsApp DMs.
 */
export function createServer(): Express {
  const app = express()
  app.use(express.json())

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', app: config.app.name, version: config.app.version })
  })

  app.get('/admin/queue', (_req, res) => {
    res.json({ depth: ingestQueue.depth })
  })

  app.get('/admin/groups', async (_req, res) => {
    res.json(await groupRepository.all())
  })

  return app
}

export function startServer(): void {
  createServer().listen(config.server.port, config.server.host, () => {
    logger.info({ port: config.server.port }, 'http listening')
  })
}
