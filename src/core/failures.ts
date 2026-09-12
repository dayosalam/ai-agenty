import { ExtractionFailed, TranscriptionFailed } from './errors.js'

/**
 * What to tell the student when something breaks.
 *
 * "Something went wrong" is the worst possible reply: it tells them nothing, gives
 * them no next step, and makes an outage indistinguishable from a question Peermate
 * simply cannot answer. Each failure a student can actually encounter gets its own
 * sentence, and every one of them ends with something they can do.
 */
export function explain(error: unknown): string {
  if (error instanceof TranscriptionFailed) {
    return "I found the voice note but couldn't make out what was said. Ask me to send the original and you can play it yourself."
  }
  if (error instanceof ExtractionFailed) {
    return "I read the message but couldn't work out what it was announcing. Try asking me about it directly."
  }

  const message = String((error as Error)?.message ?? error).toLowerCase()

  if (/rate limit|429|quota|insufficient_quota/.test(message)) {
    return "I'm being rate-limited right now. Give me a minute and ask again — nothing is lost."
  }
  if (/timeout|timed out|etimedout|econnreset|socket hang up/.test(message)) {
    return 'That took too long to come back. Try again in a moment.'
  }
  if (/openai|api key|401|403/.test(message)) {
    return "I can't reach the service I use to read and answer right now. Your messages are still being stored — ask again shortly."
  }
  if (/chroma|econnrefused.*8000/.test(message)) {
    return "I can't search what I've heard at the moment. Announcements are still arriving; try your question again in a minute."
  }
  if (/mongo|econnrefused.*27017/.test(message)) {
    return "I can't get to my records right now. Try again shortly."
  }
  if (/minio|s3|nosuchkey|not found.*bucket/.test(message)) {
    return "I have that file listed but couldn't fetch it. Ask for it again and I'll retry."
  }

  return "Something broke on my end and I couldn't finish that. Try again, and if it keeps happening tell whoever set me up."
}
