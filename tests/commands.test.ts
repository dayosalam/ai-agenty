import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { User } from '../src/models/index.js'

const saved: User[] = []
let pendingAction: 'confirm_wipe' | 'awaiting_name' | null = null

vi.mock('../src/repositories/index.js', () => ({
  userRepository: {
    upsert: vi.fn(async (user: User) => {
      saved.push(user)
    }),
    findByPhone: vi.fn(async () => saved.at(-1) ?? null),
  },
  groupRepository: { approved: vi.fn(async () => []) },
}))

vi.mock('../src/services/conversation.service.js', () => ({
  conversationService: {
    get: vi.fn(async () => (pendingAction ? { pendingAction } : null)),
    expect: vi.fn(async (_phone: string, action: typeof pendingAction) => {
      pendingAction = action
    }),
    forget: vi.fn(async () => {
      pendingAction = null
    }),
  },
}))

/** Breaks the import chain into Baileys; nothing here sends anything. */
vi.mock('../src/services/notifier.service.js', () => ({
  notifierService: { sendText: vi.fn() },
}))

const { studentCommandsService } = await import('../src/services/student-commands.service.js')

function student(over: Partial<User> = {}): User {
  return {
    phone: '2348100000000',
    jid: '2348100000000@s.whatsapp.net',
    name: 'Amina B',
    displayName: 'Amina',
    courseKeys: ['CSC301', 'STA202'],
    onboardingState: 'registered',
    registeredAt: new Date(),
    lastDigestAt: null,
    digestFormat: 'text',
    digestHour: 7,
    quietFrom: 22,
    quietTo: 6,
    pausedUntil: null,
    paused: false,
    digestPaused: false,
    alertLevel: 'all',
    mutedCourseKeys: [],
    ...over,
  }
}

const last = (): User => saved.at(-1)!

beforeEach(() => {
  saved.length = 0
  pendingAction = null
})

describe('being asked to be quiet', () => {
  it('pauses with no end when they name none', async () => {
    await studentCommandsService.handle(student(), 'stop messaging me')
    expect(last().paused).toBe(true)
    expect(last().pausedUntil).toBeNull()
  })

  it('pauses until a day they name', async () => {
    await studentCommandsService.handle(student(), 'pause until Monday')
    expect(last().paused).toBe(false)
    expect(last().pausedUntil).toBeInstanceOf(Date)
  })

  /**
   * "Stop sending morning messages" is not "stop sending messages". Reading it as a
   * full pause silences the test alerts they never asked to lose.
   */
  it('takes the digest alone when the digest is what they named', async () => {
    await studentCommandsService.handle(student(), 'stop sending me morning messages')
    expect(last().digestPaused).toBe(true)
    expect(last().paused).toBe(false)
  })

  it('mutes one course when they name one', async () => {
    await studentCommandsService.handle(student(), 'mute STA 202')
    expect(last().mutedCourseKeys).toEqual(['STA202'])
    expect(last().paused).toBe(false)
  })

  it('lifts everything on resume', async () => {
    const quiet = student({ paused: true, digestPaused: true, pausedUntil: new Date() })
    await studentCommandsService.handle(quiet, 'resume')
    expect(last().paused).toBe(false)
    expect(last().pausedUntil).toBeNull()
    expect(last().digestPaused).toBe(false)
  })

  it('narrows to urgent without silencing the digest', async () => {
    await studentCommandsService.handle(student(), 'only urgent')
    expect(last().alertLevel).toBe('urgent')
    expect(last().digestPaused).toBe(false)
  })
})

describe('destructive commands', () => {
  it('never wipes on the first ask', async () => {
    const reply = await studentCommandsService.handle(student(), 'remove everything')
    expect(saved).toHaveLength(0)
    expect(reply).toMatch(/yes/i)
    expect(pendingAction).toBe('confirm_wipe')
  })

  it('wipes only after an explicit yes', async () => {
    await studentCommandsService.handle(student(), 'delete my data')
    await studentCommandsService.handle(student(), 'yes')
    expect(last().courseKeys).toEqual([])
    expect(last().onboardingState).toBe('awaiting_name')
  })

  it('leaves everything alone on anything else', async () => {
    await studentCommandsService.handle(student(), 'forget me')
    await studentCommandsService.handle(student(), 'no')
    expect(saved).toHaveLength(0)
  })

  /** An abandoned confirmation must not swallow the next real question. */
  it('drops the question rather than answering it for them', async () => {
    await studentCommandsService.handle(student(), 'remove everything')
    const reply = await studentCommandsService.handle(student(), 'when is the CSC 301 test?')
    expect(reply).toBeNull()
    expect(saved).toHaveLength(0)
  })

  it('does not read "remove CSC 301" as removing everything', async () => {
    await studentCommandsService.handle(student(), 'remove CSC 301')
    expect(last().courseKeys).toEqual(['STA202'])
    expect(last().onboardingState).toBe('registered')
  })
})

describe('how people actually type', () => {
  it('ignores politeness in front of a command', async () => {
    expect(await studentCommandsService.handle(student(), 'abeg help')).toMatch(/what I can do/i)
  })

  it('repairs a one-word typo', async () => {
    expect(await studentCommandsService.handle(student(), 'helpp')).toMatch(/what I can do/i)
    expect(await studentCommandsService.handle(student(), 'setings')).toMatch(/digest/i)
  })

  it('leaves a real question alone', async () => {
    expect(
      await studentCommandsService.handle(student(), 'who can help me with CSC 301?'),
    ).toBeNull()
    expect(await studentCommandsService.handle(student(), 'when did the lecturer stop?')).toBeNull()
  })

  it('reads Pidgin forms of the commands it knows', async () => {
    await studentCommandsService.handle(student(), 'comot STA 202')
    expect(last().courseKeys).toEqual(['CSC301'])
  })

  it('runs both halves of "add X and remove Y"', async () => {
    const reply = await studentCommandsService.handle(student(), 'add MTH 101 and remove STA 202')
    expect(reply).toMatch(/MTH 101/)
    expect(reply).toMatch(/STA 202/)
    expect(last().courseKeys).toEqual(['CSC301', 'MTH101'])
  })

  it('takes a new name straight from the message', async () => {
    await studentCommandsService.handle(student(), 'call me Ada')
    expect(last().displayName).toBe('Ada')
  })

  it('asks which name when they only said they want to change it', async () => {
    const reply = await studentCommandsService.handle(student(), 'change my name')
    expect(reply).toMatch(/what should I call you/i)
    await studentCommandsService.handle(student(), 'Chidi')
    expect(last().displayName).toBe('Chidi')
  })
})
