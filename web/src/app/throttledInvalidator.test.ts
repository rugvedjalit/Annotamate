import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { createThrottledInvalidator, INVALIDATE_THROTTLE_MS } from './throttledInvalidator'

describe('createThrottledInvalidator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('invalidates each key once per 5 s window and refetches only active queries', () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const throttled = createThrottledInvalidator(qc, INVALIDATE_THROTTLE_MS)
    expect(INVALIDATE_THROTTLE_MS).toBe(5000)

    throttled.add(['project', 1, 'stats'], ['projects'])
    vi.advanceTimersByTime(3000)
    throttled.add(['project', 1, 'stats'])
    vi.advanceTimersByTime(1999)
    expect(invalidate).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: ['project', 1, 'stats'], refetchType: 'active' },
      { queryKey: ['projects'], refetchType: 'active' },
    ])

    // The next burst opens a new window.
    throttled.add(['projects'])
    vi.advanceTimersByTime(5000)
    expect(invalidate).toHaveBeenCalledTimes(3)
  })

  it('cancel() drops what is pending', () => {
    const qc = new QueryClient()
    const invalidate = vi.spyOn(qc, 'invalidateQueries').mockResolvedValue()
    const throttled = createThrottledInvalidator(qc, INVALIDATE_THROTTLE_MS)
    throttled.add(['projects'])
    throttled.cancel()
    vi.advanceTimersByTime(10_000)
    expect(invalidate).not.toHaveBeenCalled()
  })
})
