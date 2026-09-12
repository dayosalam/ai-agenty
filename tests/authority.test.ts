import { describe, expect, it } from 'vitest'
import type { Group, Message } from '../src/models/index.js'
import { authorityOf, describeAuthority, outranks } from '../src/utils/authority.js'

function group(trusted: Group['trustedSenders']): Group {
  return {
    chatJid: '120363000000000000@g.us',
    name: 'CSC 301 Class',
    defaultCourse: 'CSC 301',
    defaultCourseKey: 'CSC301',
    status: 'approved',
    addedBy: null,
    addedByName: null,
    participantCount: null,
    proposedCourse: null,
    proposedBy: null,
    trustedSenders: trusted,
    joinedAt: new Date(),
    approvedAt: new Date(),
  }
}

function from(senderName: string | null, senderJid = '111@lid'): Message {
  return {
    waMessageId: 'X',
    chatJid: '120363000000000000@g.us',
    senderJid,
    senderPhone: null,
    senderName,
    fromGroup: true,
    timestamp: new Date(),
    type: 'text',
    text: 'CSC 301 test Friday',
    caption: null,
    quotedMessageId: null,
    mediaKey: null,
    mimeType: null,
    fileName: null,
    transcript: null,
    processingStatus: 'pending',
    processingError: null,
    processingAttempts: 0,
    ingestedAt: new Date(),
  }
}

describe('authorityOf', () => {
  const csc = group([
    { name: 'Dr. Bello', jid: null, role: 'lecturer' },
    { name: 'Chidi', jid: null, role: 'rep' },
  ])

  it('recognises a trusted sender by name', () => {
    expect(authorityOf(from('Dr. Bello'), csc)).toBe('lecturer')
    expect(authorityOf(from('Chidi'), csc)).toBe('rep')
  })

  it('matches however the title and spacing were typed', () => {
    // The operator types "Dr. Bello"; WhatsApp shows "dr bello" or "Bello".
    for (const spelling of ['dr bello', 'DR. BELLO', 'Dr.  Bello', 'Bello']) {
      expect(authorityOf(from(spelling), csc)).toBe('lecturer')
    }
  })

  it('treats everyone else as a student', () => {
    expect(authorityOf(from('Amina'), csc)).toBe('student')
    expect(authorityOf(from(null), csc)).toBe('student')
  })

  it('treats everyone as a student when nobody is trusted', () => {
    expect(authorityOf(from('Dr. Bello'), group([]))).toBe('student')
    expect(authorityOf(from('Dr. Bello'), null)).toBe('student')
  })

  it('prefers an exact jid match over a name', () => {
    const byJid = group([{ name: 'someone else', jid: '999@lid', role: 'lecturer' }])
    expect(authorityOf(from('Amina', '999@lid'), byJid)).toBe('lecturer')
  })
})

describe('outranks', () => {
  it('orders lecturer above rep above student', () => {
    expect(outranks('lecturer', 'rep')).toBe(true)
    expect(outranks('rep', 'student')).toBe(true)
    expect(outranks('lecturer', 'student')).toBe(true)
  })

  it('is false for equal standing — a second classmate is not news', () => {
    // This is what stops three classmates producing three identical DMs.
    expect(outranks('student', 'student')).toBe(false)
    expect(outranks('lecturer', 'lecturer')).toBe(false)
  })

  it('is false downward — a classmate does not override the lecturer', () => {
    expect(outranks('student', 'lecturer')).toBe(false)
    expect(outranks('rep', 'lecturer')).toBe(false)
  })
})

describe('describeAuthority', () => {
  it('names the roles worth showing, and stays quiet about students', () => {
    expect(describeAuthority('lecturer')).toBe('lecturer')
    expect(describeAuthority('rep')).toBe('class rep')
    expect(describeAuthority('student')).toBeNull()
  })
})
