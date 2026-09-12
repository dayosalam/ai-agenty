import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { logger } from '../core/logger.js'

const GRAPH_URL = 'https://graph.facebook.com/v21.0'

/**
 * Meta WhatsApp Cloud API — the official, sanctioned send path.
 *
 * Peermate does not use this today: Baileys carries both directions (PRD §8). This
 * exists for the split-the-directions move — read groups through Baileys, send DMs
 * through Cloud API on a second number — so a ban costs ingestion rather than every
 * student's conversation.
 *
 * The cost is real and unchanged: outside a student-opened 24-hour window every
 * proactive DM becomes a paid, pre-approved template, which is most of them under
 * the instant-alert policy.
 *
 * Ported from Meta's Jasper's Market sample. The catalog, carousel and offer-template
 * calls were dropped — they were shop demos, not anything Peermate sends.
 */
export class CloudApiService {
  get configured(): boolean {
    return Boolean(config.cloudApi.accessToken && config.cloudApi.phoneNumberId)
  }

  async sendText(toPhone: string, text: string): Promise<void> {
    await this.call({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhone,
      type: 'text',
      text: { body: text },
    })
  }

  /**
   * Unlike Baileys, Cloud API does take a URL — Meta fetches the file itself, so it
   * must be reachable from the public internet, not a localhost MinIO.
   */
  async sendDocument(
    toPhone: string,
    link: string,
    filename: string,
    caption?: string,
  ): Promise<void> {
    await this.call({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhone,
      type: 'document',
      document: { link, filename, ...(caption ? { caption } : {}) },
    })
  }

  /** Outside the 24-hour window this is the only thing Meta will deliver. */
  async sendTemplate(toPhone: string, templateName: string, locale = 'en'): Promise<void> {
    await this.call({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toPhone,
      type: 'template',
      template: { name: templateName, language: { code: locale } },
    })
  }

  private async call(body: Record<string, unknown>): Promise<void> {
    if (!this.configured) {
      throw new Error(
        'Cloud API is not configured — set CLOUD_API_ACCESS_TOKEN and CLOUD_API_PHONE_NUMBER_ID',
      )
    }
    const response = await fetch(`${GRAPH_URL}/${config.cloudApi.phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.cloudApi.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(`Cloud API ${response.status}: ${await response.text()}`)
    }
    logger.info({ to: body['to'], type: body['type'] }, 'cloud api message sent')
  }
}

/**
 * Verifies a Cloud API webhook came from Meta.
 *
 * The sample compared hashes with `!=`, which leaks timing. Uses a constant-time
 * comparison instead — this guards an endpoint anyone can reach.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader || !config.cloudApi.appSecret) return false
  const expected = createHmac('sha256', config.cloudApi.appSecret).update(rawBody).digest('hex')
  const received = signatureHeader.split('=')[1] ?? ''
  if (received.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(received, 'utf8'), Buffer.from(expected, 'utf8'))
}

/** The GET handshake Meta performs when a webhook URL is first registered. */
export function verifyWebhookChallenge(mode: string, token: string): boolean {
  return (
    mode === 'subscribe' &&
    token === config.cloudApi.verifyToken &&
    Boolean(config.cloudApi.verifyToken)
  )
}

export const cloudApiService = new CloudApiService()
