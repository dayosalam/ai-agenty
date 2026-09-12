import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GroupSendForbidden } from '../src/core/errors.js'

let comesBack = true
vi.mock('../src/whatsapp/socket.js', () => ({
  getSocket: vi.fn(() => {
    throw new Error('not connected')
  }),
  whenOpen: vi.fn(async () => comesBack),
}))

const { NotifierService } = await import('../src/services/notifier.service.js')

/**
 * "Peermate never posts in a group" is the hardest invariant in the PRD and it is
 * enforced by a single branch. These tests exist so that branch cannot be removed
 * quietly.
 */
describe('NotifierService group guard', () => {
  const notifier = new NotifierService()

  it('refuses to send text into a group', async () => {
    await expect(notifier.sendText('120363000000000000@g.us', 'hi')).rejects.toBeInstanceOf(
      GroupSendForbidden,
    )
  })

  it('refuses to send a file into a group', async () => {
    await expect(
      notifier.sendFile('120363000000000000@g.us', 'document/x', 'x.pdf'),
    ).rejects.toBeInstanceOf(GroupSendForbidden)
  })

  it('rejects before touching the socket or MinIO', async () => {
    // If the guard ran after the socket lookup the error would be "not connected",
    // which would mean a live process could reach sendMessage with a group JID.
    await expect(notifier.sendText('120363000000000000@g.us', 'hi')).rejects.not.toThrow(
      /not connected/,
    )
  })
})

/**
 * WhatsApp drops the socket often enough that a reply lands mid-outage. Retrying on a
 * fixed timer failed again while Baileys was still dialling back in, and the answer was
 * lost — silence the student cannot tell from Peermate having nothing to say.
 */
describe('NotifierService retry', () => {
  const attempt = (send: () => Promise<unknown>): Promise<void> => {
    const notifier = new NotifierService()
    // withRetry is private by design; exercise it through the path sendText uses.
    const withRetry = Reflect.get(notifier, 'withRetry').bind(notifier) as (
      fn: () => Promise<unknown>,
      jid: string,
    ) => Promise<void>
    return withRetry(send, '2348012345678@s.whatsapp.net')
  }

  beforeEach(() => {
    comesBack = true
  })

  it('sends again once the socket is back', async () => {
    vi.useFakeTimers()
    const send = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('Connection Closed'))
      .mockResolvedValueOnce(undefined)

    const pending = attempt(send)
    await vi.advanceTimersByTimeAsync(2000)
    await pending

    expect(send).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('gives up after three tries rather than looping', async () => {
    vi.useFakeTimers()
    const send = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error('down'))

    const pending = attempt(send).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(await pending).toBeInstanceOf(Error)
    expect(send).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  /** No point spending two more attempts on a socket that is not coming back. */
  it('stops as soon as the socket is declared gone', async () => {
    vi.useFakeTimers()
    comesBack = false
    const send = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error('down'))

    const pending = attempt(send).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(await pending).toBeInstanceOf(Error)
    expect(send).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
