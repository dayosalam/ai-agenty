import { GroupSendForbidden } from '../core/errors.js'
import { logger } from '../core/logger.js'
import { getMedia } from '../db/minio.js'
import { isBroadcastJid, isGroupJid } from '../whatsapp/jid.js'
import { getSocket } from '../whatsapp/socket.js'
import { VOICE_MIME } from './tts.service.js'

const RETRY_DELAY_MS = 2000

/** WhatsApp drops a composing presence after ~10s, so refresh inside that window. */
const TYPING_REFRESH_MS = 6000

/**
 * The only module that sends. Everything outbound funnels through here, which is
 * what keeps the never-post-in-a-group invariant checkable in one place — and what
 * makes the split-the-directions move in PRD §8 a one-class change.
 */
export class NotifierService {
  /**
   * "I am working on it", for the seconds transcription or retrieval takes.
   * Best-effort: never let a presence update break the reply it precedes.
   */
  async showTyping(jid: string): Promise<void> {
    if (isGroupJid(jid) || isBroadcastJid(jid)) return
    try {
      await getSocket().sendPresenceUpdate('composing', jid)
    } catch (error) {
      logger.debug({ err: error, jid }, 'could not send typing indicator')
    }
  }

  /**
   * Keeps "typing…" visible for as long as the work takes.
   *
   * WhatsApp expires a composing presence after roughly ten seconds, so a single
   * update goes stale long before a transcription or a retrieval finishes — the
   * student sees the indicator vanish and assumes nothing is happening. Refreshing
   * it on a timer is the difference between "thinking" and "broken".
   */
  async withTyping<T>(jid: string, work: () => Promise<T>): Promise<T> {
    await this.showTyping(jid)
    const timer = setInterval(() => void this.showTyping(jid), TYPING_REFRESH_MS)
    try {
      return await work()
    } finally {
      clearInterval(timer)
      try {
        await getSocket().sendPresenceUpdate('paused', jid)
      } catch {
        // The reply itself clears the indicator, so this is cosmetic.
      }
    }
  }

  async sendText(jid: string, text: string): Promise<void> {
    this.assertNotGroup(jid)
    await this.withRetry(() => getSocket().sendMessage(jid, { text }), jid)
    logger.info({ jid }, 'dm sent')
  }

  /**
   * Baileys has no send-by-URL: it uploads to WhatsApp's CDN itself, so the bytes
   * must come back out of MinIO and through this process.
   */
  async sendFile(
    jid: string,
    mediaKey: string,
    fileName: string,
    mimeType = 'application/octet-stream',
    caption?: string,
  ): Promise<void> {
    this.assertNotGroup(jid)
    const document = await getMedia(mediaKey)
    await this.withRetry(
      () => getSocket().sendMessage(jid, { document, fileName, mimetype: mimeType, caption }),
      jid,
    )
    logger.info({ jid, fileName }, 'file sent')
  }

  /**
   * One retry, per the PRD failure table. The caller logs a single notification
   * either way, so a retry never doubles the delivery record.
   *
   * The risk this accepts: if the first send arrived but its acknowledgement did
   * not, the retry delivers the message twice. A duplicate DM is a smaller failure
   * than a student never hearing about their test, which is the trade the PRD makes.
   */
  private async withRetry(send: () => Promise<unknown>, jid: string): Promise<void> {
    try {
      await send()
    } catch (error) {
      logger.warn({ err: error, jid }, 'send failed, retrying once')
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
      await send()
    }
  }

  /** Inline, not as a file to download — an image sent as a document is unreadable. */
  async sendImage(jid: string, image: Buffer, caption?: string): Promise<void> {
    this.assertNotGroup(jid)
    await this.withRetry(() => getSocket().sendMessage(jid, { image, caption }), jid)
    logger.info({ jid, bytes: image.length }, 'image sent')
  }

  /**
   * A real voice note, not an audio attachment. `ptt: true` is what gives it the
   * waveform and inline play button; without it WhatsApp shows a file to download.
   */
  async sendVoiceNote(jid: string, audio: Buffer): Promise<void> {
    this.assertNotGroup(jid)
    await this.withRetry(
      () => getSocket().sendMessage(jid, { audio, mimetype: VOICE_MIME, ptt: true }),
      jid,
    )
    logger.info({ jid, bytes: audio.length }, 'voice note sent')
  }

  /** Never retried — sending to a non-person is a bug, not a transient failure. */
  private assertNotGroup(jid: string): void {
    if (isGroupJid(jid)) {
      throw new GroupSendForbidden(`refused to send into group ${jid} — Peermate never posts`)
    }
    // Sending here would publish a Status update to the account's contacts.
    if (isBroadcastJid(jid)) {
      throw new GroupSendForbidden(`refused to send to broadcast ${jid} — Peermate never posts`)
    }
  }
}

export const notifierService = new NotifierService()
