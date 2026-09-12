import { describe, expect, it, vi } from 'vitest'
import { GroupSendForbidden } from '../src/core/errors.js'
import { NotifierService } from '../src/services/notifier.service.js'

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

describe('NotifierService retry', () => {
  it('retries a failed send exactly once', async () => {
    vi.useFakeTimers()
    const send = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('socket blip'))
      .mockResolvedValueOnce(undefined)

    const notifier = new NotifierService()
    // withRetry is private by design; exercise it through the same path sendText uses.
    const withRetry = Reflect.get(notifier, 'withRetry').bind(notifier) as (
      fn: () => Promise<unknown>,
      jid: string,
    ) => Promise<void>

    const pending = withRetry(send, '2348012345678@s.whatsapp.net')
    await vi.advanceTimersByTimeAsync(2000)
    await pending

    expect(send).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('gives up after the second failure rather than looping', async () => {
    vi.useFakeTimers()
    const send = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error('down'))

    const notifier = new NotifierService()
    const withRetry = Reflect.get(notifier, 'withRetry').bind(notifier) as (
      fn: () => Promise<unknown>,
      jid: string,
    ) => Promise<void>

    const pending = withRetry(send, '2348012345678@s.whatsapp.net').catch((error) => error)
    await vi.advanceTimersByTimeAsync(2000)
    const result = await pending

    expect(send).toHaveBeenCalledTimes(2)
    expect(result).toBeInstanceOf(Error)
    vi.useRealTimers()
  })
})
