import { afterEach, describe, expect, test, vi } from 'vitest'
import { timeoutPromise } from '../src/utils/timeout'

describe('timeoutPromise', () => {
  afterEach(() => vi.useRealTimers())

  test('resolves when the promise wins', async () => {
    await expect(timeoutPromise(Promise.resolve('ok'), 'too slow', 50)).resolves.toBe('ok')
  })

  test('rejects with the reason when the timeout wins', async () => {
    const never = new Promise(() => {})
    await expect(timeoutPromise(never, 'too slow', 10)).rejects.toThrow('too slow')
  })

  test('clears its timer once the promise wins the race', async () => {
    vi.useFakeTimers()
    await timeoutPromise(Promise.resolve('ok'), 'too slow', 5000)
    expect(vi.getTimerCount()).toBe(0)
  })
})
