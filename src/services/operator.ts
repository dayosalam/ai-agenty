import { config } from '../config.js'
import { userRepository } from '../repositories/index.js'
import { phoneToJid, samePhone } from '../whatsapp/jid.js'

/**
 * Where to send operator messages.
 *
 * One person, one address. WhatsApp is migrating to LID addressing and reaches the
 * same handset two ways — `2349021527907@s.whatsapp.net` and `210260258201705@lid` —
 * and Signal keeps a *separate ratchet per address*. Alternating between them, which
 * is what happens when operator notices go to the configured phone while replies go
 * to the JID their messages arrive on, desynchronises both: the phone starts showing
 * "Waiting for this message. This may take a while." and the text is never readable.
 *
 * So when the operator is also a registered user, address them exactly the way they
 * address Peermate. `ADMIN_PHONE` still decides who *may* command it — several
 * spellings of the same person are fine there — but only one of them is ever written to.
 */
export async function operatorJid(): Promise<string | null> {
  if (config.admin.phones.length === 0) return null

  for (const phone of config.admin.phones) {
    const user = await userRepository.findByPhone(phone)
    if (user?.jid) return user.jid
  }

  // Not registered, so there is no observed address to prefer. Fall back to the
  // first configured spelling.
  const [first] = config.admin.phones
  return first ? phoneToJid(first) : null
}

/** Whether a stored identity belongs to a configured operator, however it is spelled. */
export function isOperatorIdentity(identity: string): boolean {
  return config.admin.phones.some((phone) => samePhone(identity, phone))
}
