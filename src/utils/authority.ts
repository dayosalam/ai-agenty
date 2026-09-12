import type { Authority, Group, Message } from '../models/index.js'

const RANK: Record<Authority, number> = { lecturer: 3, rep: 2, student: 1 }

/**
 * Who is speaking, as far as this group is concerned.
 *
 * Matched on the sender's WhatsApp name rather than their number: group
 * participants now arrive as opaque LIDs, and the operator naming "Dr. Bello" knows
 * them by the name in the chat, not by a phone number they may not even have.
 */
export function authorityOf(message: Message, group: Group | null): Authority {
  if (!group || group.trustedSenders.length === 0) return 'student'

  const name = normalize(message.senderName)
  for (const trusted of group.trustedSenders) {
    if (trusted.jid && message.senderJid === trusted.jid) return trusted.role
    if (name && normalize(trusted.name) === name) return trusted.role
  }
  return 'student'
}

export function outranks(a: Authority, b: Authority): boolean {
  return RANK[a] > RANK[b]
}

export function describeAuthority(authority: Authority): string | null {
  switch (authority) {
    case 'lecturer':
      return 'lecturer'
    case 'rep':
      return 'class rep'
    default:
      return null
  }
}

/** Names get typed inconsistently — "Dr Bello", "dr. bello", "Dr.  Bello". */
function normalize(name: string | null | undefined): string | null {
  if (!name) return null
  const cleaned = name
    .toLowerCase()
    .replace(/\b(dr|prof|mr|mrs|ms|engr|miss)\.?\s*/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return cleaned || null
}
