import { describe, expect, it } from 'vitest'
import {
  isGroupJid,
  isLidJid,
  isUserJid,
  jidToIdentity,
  jidToPhone,
  phoneToJid,
  samePhone,
} from '../src/whatsapp/jid.js'

describe('phoneToJid', () => {
  it('expands a Nigerian local number to the country code', () => {
    expect(phoneToJid('08012345678')).toBe('2348012345678@s.whatsapp.net')
  })

  it('strips the punctuation people type', () => {
    expect(phoneToJid('+234 801 234-5678')).toBe('2348012345678@s.whatsapp.net')
  })

  /**
   * WhatsApp reaches one handset two ways, and Signal keeps a separate ratchet per
   * address. Appending @s.whatsapp.net to a LID built a third address that belongs
   * to nobody — never delivered, and never an error either.
   */
  it('leaves an identifier that is already a JID alone', () => {
    expect(phoneToJid('210260258201705@lid')).toBe('210260258201705@lid')
    expect(phoneToJid('2348012345678@s.whatsapp.net')).toBe('2348012345678@s.whatsapp.net')
  })

  it('uses the Baileys suffix, never Green API’s @c.us', () => {
    // A wrong suffix raises nothing — the DM is simply never delivered.
    expect(phoneToJid('08012345678')).not.toContain('@c.us')
  })
})

describe('jidToPhone', () => {
  it('drops the multi-device suffix', () => {
    expect(jidToPhone('2348012345678:12@s.whatsapp.net')).toBe('2348012345678')
  })

  it('returns null for a group, which has no phone number', () => {
    expect(jidToPhone('120363000000000000@g.us')).toBeNull()
  })
})

describe('jid predicates', () => {
  it('separates groups from individuals', () => {
    expect(isGroupJid('120363000000000000@g.us')).toBe(true)
    expect(isUserJid('120363000000000000@g.us')).toBe(false)
    expect(isUserJid('2348012345678@s.whatsapp.net')).toBe(true)
  })
})

describe('LID handling', () => {
  const LID = '210260258201705@lid'

  it('never reports a LID as a phone number', () => {
    // Its digits look like a number but cannot be dialled or matched to a student.
    // Returning them created a user keyed by an unreachable identifier.
    expect(jidToPhone(LID)).toBeNull()
  })

  it('still yields a stable identity for a LID', () => {
    expect(jidToIdentity(LID)).toBe('210260258201705@lid')
    expect(jidToIdentity('2348012345678:12@s.whatsapp.net')).toBe('2348012345678')
  })

  it('treats a LID as an addressable individual, not a group', () => {
    expect(isLidJid(LID)).toBe(true)
    expect(isUserJid(LID)).toBe(true)
    expect(isGroupJid(LID)).toBe(false)
  })
})

describe('samePhone', () => {
  it('matches the same number written in local, international and JID form', () => {
    expect(samePhone('09021527907', '2349021527907')).toBe(true)
    expect(samePhone('2349021527907@s.whatsapp.net', '09021527907')).toBe(true)
    expect(samePhone('+234 902 152 7907', '2349021527907')).toBe(true)
  })

  it('does not match different numbers, or nothing at all', () => {
    expect(samePhone('09021527907', '08101856106')).toBe(false)
    expect(samePhone('', '2349021527907')).toBe(false)
    expect(samePhone(null, null)).toBe(false)
  })
})
