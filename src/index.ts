import { logger } from './core/logger.js'
import { connectChroma } from './db/chroma.js'
import { connectMinio } from './db/minio.js'
import { closeMongo, connectMongo } from './db/mongo.js'
import { startServer } from './http/server.js'
import { startScheduler } from './scheduler/index.js'
import { deliveryService } from './services/delivery.service.js'
import { resourceAlertService } from './services/resource-alert.service.js'
import { groupService } from './services/group.service.js'
import { connectWhatsApp, onGroupJoin, onMessage } from './whatsapp/socket.js'
import { ingestQueue, recoverUnfinished } from './workers/ingest.worker.js'

async function main(): Promise<void> {
  await connectMongo()
  await connectMinio()
  await connectChroma()

  // The socket handler does nothing but enqueue, so a slow transcription can never
  // stall WhatsApp ingestion.
  onMessage((message) => ingestQueue.push(message))
  onGroupJoin((chatJid, subject) => {
    void groupService
      .register(chatJid, subject)
      .catch((error) => logger.error({ err: error, chatJid }, 'group registration failed'))
  })
  await connectWhatsApp()

  startScheduler()
  startServer()

  // After the socket is up, so recovered announcements can still be delivered.
  void recoverUnfinished().catch((error) => logger.error({ err: error }, 'recovery sweep failed'))
  logger.info('peermate up')
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      logger.info({ signal }, 'shutting down')
      await ingestQueue.drain()
      await resourceAlertService.flushAll()
      await deliveryService.flushAll()
      await closeMongo()
      process.exit(0)
    })()
  })
}

main().catch((error) => {
  logger.fatal({ err: error }, 'failed to start')
  process.exit(1)
})
