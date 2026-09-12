import { Client } from 'minio'
import { config } from '../config.js'
import { logger } from '../core/logger.js'

let client: Client | null = null

export async function connectMinio(): Promise<Client> {
  if (client) return client
  client = new Client({
    endPoint: config.minio.endPoint,
    port: config.minio.port,
    useSSL: config.minio.useSSL,
    accessKey: config.minio.accessKey,
    secretKey: config.minio.secretKey,
  })
  if (!(await client.bucketExists(config.minio.bucket))) {
    await client.makeBucket(config.minio.bucket)
  }
  logger.info({ bucket: config.minio.bucket }, 'minio connected')
  return client
}

export function getMinio(): Client {
  if (!client) throw new Error('MinIO not connected — call connectMinio() during startup')
  return client
}

export async function putMedia(
  key: string,
  body: Buffer,
  mimeType?: string | null,
): Promise<string> {
  await getMinio().putObject(config.minio.bucket, key, body, body.length, {
    'Content-Type': mimeType ?? 'application/octet-stream',
  })
  return key
}

export async function getMedia(key: string): Promise<Buffer> {
  const stream = await getMinio().getObject(config.minio.bucket, key)
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}
