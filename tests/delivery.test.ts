import { describe, expect, it, vi } from 'vitest'
import type { User } from '../src/models/index.js'

vi.mock('../src/services/notifier.service.js', () => ({
  notifierService: { sendText: vi.fn() },
}))
vi.mock('../src/repositories/index.js', () => ({
  conversationRepository: { find: vi.fn(async () => null) },
}))

const { DeliveryService } = await import('../src/services/delivery.service.js')
const service = new DeliveryService()

/** heldReason is private; this is the same decision send() makes. */
const held = (student: User, about: unknown): string | null =>
  (Reflect.get(service, 'heldReason') as (u: User, a: unknown) => string | null).call(
    service,
    student,
    about,
  )

function student(over: Partial<User> = {}): User {
  return {
    phone: '2348100000000',
    jid: '2348100000000@s.whatsapp.net',
    name: null,
    displayName: 'Amina',
    courseKeys: ['CSC301'],
    onboardingState: 'registered',
    registeredAt: new Date(),
    lastDigestAt: null,
    digestFormat: 'text',
    digestHour: 7,
    quietFrom: null,
    quietTo: null,
    pausedUntil: null,
    paused: false,
    digestPaused: false,
    alertLevel: 'all',
    mutedCourseKeys: [],
    ...over,
  }
}

const alert = { kind: 'announcement', courseKey: 'CSC301', eventType: 'test' }

describe('who gets messaged right now', () => {
  it('messages a student who asked for nothing else', () => {
    expect(held(student(), alert)).toBeNull()
  })

  it('honours a pause everywhere, whatever the message is', () => {
    const quiet = student({ paused: true })
    for (const kind of ['announcement', 'resource', 'digest', 'deadline']) {
      expect(held(quiet, { ...alert, kind })).not.toBeNull()
    }
  })

  it('lets a pause lapse on its own', () => {
    const over = student({ pausedUntil: new Date(Date.now() - 1000) })
    expect(held(over, alert)).toBeNull()
    expect(DeliveryService.expired(over)).toBe(true)
  })

  /**
   * "Stop the morning messages" must not stop the test alerts, and muting one course
   * must not mute the rest. Both are the whole point of having separate switches.
   */
  it('keeps the switches separate', () => {
    expect(held(student({ digestPaused: true }), alert)).toBeNull()
    expect(held(student({ digestPaused: true }), { kind: 'digest' })).not.toBeNull()

    const muted = student({ courseKeys: ['CSC301', 'STA202'], mutedCourseKeys: ['STA202'] })
    expect(held(muted, alert)).toBeNull()
    expect(held(muted, { ...alert, courseKey: 'STA202' })).not.toBeNull()
  })

  it('holds everything but tests, deadlines and venue changes on urgent-only', () => {
    const picky = student({ alertLevel: 'urgent' })
    expect(held(picky, { ...alert, eventType: 'test' })).toBeNull()
    expect(held(picky, { ...alert, eventType: 'venue_change' })).toBeNull()
    expect(held(picky, { ...alert, eventType: 'lecture' })).not.toBeNull()
    expect(held(picky, { kind: 'resource', courseKey: 'CSC301' })).not.toBeNull()
    // The digest is what the held items arrive in, so it is never narrowed.
    expect(held(picky, { kind: 'digest' })).toBeNull()
  })

  it('says what it is holding back, so settings can read it out', () => {
    expect(DeliveryService.describeHolds(student())).toEqual([])
    expect(DeliveryService.describeHolds(student({ paused: true }))[0]).toMatch(/resume/i)
    expect(DeliveryService.describeHolds(student({ alertLevel: 'urgent' }))[0]).toMatch(/urgent/i)
  })
})
