import 'dotenv/config'
import { z } from 'zod'
import defaults from './data/defaults.json' with { type: 'json' }

/**
 * z.coerce.boolean() is the wrong tool for env vars: it is Boolean(string), so the
 * string "false" coerces to true and MINIO_USE_SSL=false would silently enable TLS.
 */
const booleanFromEnv = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1')

const envSchema = z.object({
  ENVIRONMENT: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().default(defaults.server.port),

  MONGODB_URL: z.string().default('mongodb://localhost:27017'),
  MONGODB_DATABASE: z.string().default(defaults.database.mongodbDatabase),

  CHROMA_URL: z.string().default(defaults.database.chromaUrl),

  MINIO_ENDPOINT: z.string().default('localhost:9000'),
  MINIO_ACCESS_KEY: z.string().default('peermate-local'),
  MINIO_SECRET_KEY: z.string().default('peermate-local-dev'),
  MINIO_USE_SSL: booleanFromEnv.default('false'),

  WHATSAPP_AUTH_DIR: z.string().default(defaults.whatsapp.authDir),
  // Set to pair with an 8-character code instead of scanning a QR.
  WHATSAPP_PAIRING_NUMBER: z.string().default(''),

  OPENAI_API_KEY: z.string().default(''),

  // Exa. Optional: with no key, prep is built from the shared files alone and the
  // further-reading section is simply absent.
  EXA_API_KEY: z.string().default(''),

  INGEST_CONCURRENCY: z.coerce.number().default(defaults.ingest.concurrency),

  // Off during a live demo: an alert held for a minute looks like an alert that
  // never came, when the whole point on screen is that it arrives instantly.
  DEFER_ALERTS: booleanFromEnv.default('true'),

  // Meta Cloud API — unused today, kept wired for the split-directions move in PRD §8.
  ACCESS_TOKEN: z.string().default(''),
  APP_SECRET: z.string().default(''),
  VERIFY_TOKEN: z.string().default(''),
  CLOUD_API_PHONE_NUMBER_ID: z.string().default(''),

  // The operators. The only people Peermate messages without being written to
  // first. Comma-separated, so the person who runs the bot and the person testing
  // it on another handset can both approve groups.
  ADMIN_PHONE: z.string().default(''),

  // Baileys logs a failed optional init query at error level on most connects. It
  // is noise — our own connection.update logging covers what actually matters.
  BAILEYS_LOG_LEVEL: z.enum(['silent', 'error', 'warn', 'info', 'debug']).default('silent'),
})

const env = envSchema.parse(process.env)

/**
 * A hosted MinIO is written as a bare hostname and served on the standard port; a
 * local one carries its port. Defaulting a missing port to 9000 makes a TLS
 * connection to a port nothing is listening on, which surfaces as a timeout rather
 * than as anything that names the cause.
 */
const [minioHost, minioPort] = env.MINIO_ENDPOINT.split(':')

export const config = {
  env: env.ENVIRONMENT,
  logLevel: env.LOG_LEVEL,
  isProduction: env.ENVIRONMENT === 'production',

  app: defaults.app,
  server: { host: defaults.server.host, port: env.PORT },

  mongo: { url: env.MONGODB_URL, database: env.MONGODB_DATABASE },
  chroma: { url: env.CHROMA_URL, collection: defaults.database.chromaCollection },
  minio: {
    endPoint: minioHost!,
    port: minioPort ? Number(minioPort) : env.MINIO_USE_SSL ? 443 : 9000,
    useSSL: env.MINIO_USE_SSL,
    accessKey: env.MINIO_ACCESS_KEY,
    secretKey: env.MINIO_SECRET_KEY,
    bucket: defaults.minio.bucketMedia,
  },
  whatsapp: { authDir: env.WHATSAPP_AUTH_DIR, pairingNumber: env.WHATSAPP_PAIRING_NUMBER },
  openai: { apiKey: env.OPENAI_API_KEY, ...defaults.llm },
  research: { apiKey: env.EXA_API_KEY, enabled: env.EXA_API_KEY !== '', ...defaults.research },
  embeddings: defaults.embeddings,
  retrieval: defaults.retrieval,
  /** How long a group must fall quiet before new files are announced as one batch. */
  resourceAlertDelayMs: defaults.resources.alertDelaySeconds * 1000,
  digest: defaults.digest,
  delivery: {
    enabled: env.DEFER_ALERTS,
    conversationActiveMs: defaults.delivery.conversationActiveSeconds * 1000,
    deferMs: defaults.delivery.deferSeconds * 1000,
    maxDeferMs: defaults.delivery.maxDeferSeconds * 1000,
  },
  ingest: { concurrency: env.INGEST_CONCURRENCY },
  admin: {
    /** First entry is the one Peermate writes to; every entry may send commands. */
    phones: env.ADMIN_PHONE.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    get phone(): string {
      return this.phones[0] ?? ''
    },
  },
  baileysLogLevel: env.BAILEYS_LOG_LEVEL,
  cloudApi: {
    accessToken: env.ACCESS_TOKEN,
    appSecret: env.APP_SECRET,
    verifyToken: env.VERIFY_TOKEN,
    phoneNumberId: env.CLOUD_API_PHONE_NUMBER_ID,
  },
} as const

export type Config = typeof config
