/**
 * Phone <-> JID conversion.
 *
 * Ported from formatPhoneAsChatID in unimart-api, with the suffix changed: Baileys
 * addresses individuals as `@s.whatsapp.net`, not Green API's `@c.us`. A wrong
 * suffix does not raise — the DM is simply never delivered — so this lives in one
 * place and nothing else builds a JID by hand.
 */

export const USER_SUFFIX = '@s.whatsapp.net'
export const GROUP_SUFFIX = '@g.us'
/**
 * WhatsApp's privacy-preserving identifier. In groups a participant is increasingly
 * addressed as `<lid>@lid` rather than by phone number, and a LID's digits are NOT a
 * phone number — storing one as `senderPhone` produces a value that can never be
 * messaged and never matches a registered student.
 */
export const LID_SUFFIX = '@lid'

/**
 * Endpoints that are not people.
 *
 * `status@broadcast` carries everyone's Status posts, and a Status arrives looking
 * exactly like an incoming message. Treated as a DM it creates a "student" called
 * status — and worse, replying to it posts a Status update visible to contacts.
 * Peermate is a reader; it must never write to any of these.
 */
export const BROADCAST_SUFFIX = '@broadcast'
export const NEWSLETTER_SUFFIX = '@newsletter'

export function phoneToJid(phone: string): string {
  // Already a JID — a LID especially. Appending @s.whatsapp.net to
  // "210260258201705@lid" produces a malformed address that raises nothing and is
  // simply never delivered, which is the failure this whole module exists to stop.
  if (phone.includes('@')) return phone

  let normalized = phone.replace(/[+\s\-()]/g, '')
  // Nigerian local format: leading 0 + 10 digits -> country code 234
  if (normalized.startsWith('0') && normalized.length === 11) {
    normalized = `234${normalized.slice(1)}`
  }
  return `${normalized}${USER_SUFFIX}`
}

/**
 * Digits only, for storage and display.
 *
 * Returns null for a group and for a LID: neither is a phone number, and returning
 * the digits anyway is what created users keyed by an unreachable identifier.
 */
export function jidToPhone(jid: string): string | null {
  if (isGroupJid(jid) || isLidJid(jid) || isBroadcastJid(jid)) return null
  const [user] = jid.split('@')
  // Multi-device JIDs can carry a device suffix (`2348012345678:12@...`).
  return user?.split(':')[0] ?? null
}

/** The stable key for a participant, whether WhatsApp gave us a phone or a LID. */
export function jidToIdentity(jid: string): string | null {
  if (isBroadcastJid(jid)) return null
  const [user] = jid.split('@')
  const bare = user?.split(':')[0]
  if (!bare) return null
  return isLidJid(jid) ? `${bare}${LID_SUFFIX}` : bare
}

export function isGroupJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith(GROUP_SUFFIX)
}

/** Status posts, broadcast lists and channels — never a conversation partner. */
export function isBroadcastJid(jid: string | null | undefined): boolean {
  return !!jid && (jid.endsWith(BROADCAST_SUFFIX) || jid.endsWith(NEWSLETTER_SUFFIX))
}

/** Anything Peermate must neither ingest as a DM nor ever send to. */
export function isNotAPerson(jid: string | null | undefined): boolean {
  return isBroadcastJid(jid) || isGroupJid(jid)
}

export function isLidJid(jid: string | null | undefined): boolean {
  return !!jid && jid.endsWith(LID_SUFFIX)
}

/** An addressable individual — a LID counts, since Baileys can send to one. */
export function isUserJid(jid: string | null | undefined): boolean {
  return !!jid && (jid.endsWith(USER_SUFFIX) || jid.endsWith(LID_SUFFIX))
}

/** Compares two identifiers that may be written in local, international or JID form. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const norm = (value: string): string => {
    const digits = value.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') ?? ''
    return digits.startsWith('0') && digits.length === 11 ? `234${digits.slice(1)}` : digits
  }
  return norm(a) === norm(b) && norm(a).length > 0
}
