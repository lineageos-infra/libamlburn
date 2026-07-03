import { describe, expect, test } from 'vitest'
import { timeoutPromise } from '../src/utils/timeout'

describe('timeoutPromise', () => {
  test('resolves when the promise wins', async () => {
    await expect(timeoutPromise(Promise.resolve('ok'), 'too slow', 50)).resolves.toBe('ok')
  })

  test('rejects with the reason when the timeout wins', async () => {
    const never = new Promise(() => {})
    await expect(timeoutPromise(never, 'too slow', 10)).rejects.toThrow('too slow')
  })
})
