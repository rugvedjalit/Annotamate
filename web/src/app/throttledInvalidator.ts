import type { QueryClient, QueryKey } from '@tanstack/react-query'

/** Window of the throttled invalidation: bursts of events (a team saving, a bulk change) cost one refetch. */
export const INVALIDATE_THROTTLE_MS = 5000

/**
 * Collects query keys and invalidates them once per window (bursty events → one refetch). Only queries on
 * screen are refetched; the others are marked stale and load when they are next used.
 */
export function createThrottledInvalidator(qc: QueryClient, delayMs: number) {
  const pending = new Map<string, QueryKey>()
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    add(...keys: QueryKey[]) {
      for (const k of keys) pending.set(JSON.stringify(k), k)
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        const keysNow = [...pending.values()]
        pending.clear()
        for (const k of keysNow) void qc.invalidateQueries({ queryKey: k, refetchType: 'active' })
      }, delayMs)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      pending.clear()
    },
  }
}
