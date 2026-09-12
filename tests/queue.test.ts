import { describe, expect, it } from 'vitest'
import { Queue } from '../src/workers/queue.js'

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('Queue', () => {
  it('processes every pushed item', async () => {
    const seen: number[] = []
    const queue = new Queue<number>(async (n) => void seen.push(n), 2, 'test')

    for (const n of [1, 2, 3, 4, 5]) queue.push(n)
    await queue.drain()

    expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
  })

  it('never runs more than `concurrency` handlers at once', async () => {
    let active = 0
    let peak = 0
    const queue = new Queue<number>(
      async () => {
        active += 1
        peak = Math.max(peak, active)
        await tick(10)
        active -= 1
      },
      2,
      'test',
    )

    for (let i = 0; i < 8; i += 1) queue.push(i)
    await queue.drain()

    expect(peak).toBe(2)
  })

  it('a throwing handler never rejects into the caller', async () => {
    // This is the invariant that keeps WhatsApp ingestion alive: an unhandled
    // rejection here would take the socket down with it.
    const queue = new Queue<number>(
      async () => {
        throw new Error('extraction exploded')
      },
      1,
      'test',
    )

    expect(() => queue.push(1)).not.toThrow()
    await expect(queue.drain()).resolves.toBeUndefined()
  })

  it('keeps processing after one item fails', async () => {
    const seen: number[] = []
    const queue = new Queue<number>(
      async (n) => {
        if (n === 2) throw new Error('bad message')
        seen.push(n)
      },
      1,
      'test',
    )

    for (const n of [1, 2, 3]) queue.push(n)
    await queue.drain()

    expect(seen).toEqual([1, 3])
  })

  it('reports depth so the admin endpoint means something', async () => {
    const queue = new Queue<number>(async () => tick(20), 1, 'test')
    queue.push(1)
    queue.push(2)
    expect(queue.depth).toBe(2)
    await queue.drain()
    expect(queue.depth).toBe(0)
  })

  it('drain resolves immediately when nothing is queued', async () => {
    const queue = new Queue<number>(async () => {}, 1, 'test')
    await expect(queue.drain()).resolves.toBeUndefined()
  })
})
