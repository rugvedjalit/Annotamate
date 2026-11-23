import { useQuery } from '@tanstack/react-query'
import { getProjectStats } from '@/lib/endpoints'
import { qk } from '@/lib/queryKeys'

export function useProjectStats(projectId: number) {
  return useQuery({
    queryKey: qk.stats(projectId),
    queryFn: ({ signal }) => getProjectStats(projectId, { signal }),
    staleTime: 20_000,
  })
}

/** Axis maximum for whole-number counts: an even "nice" number (2, 4, 6, 8, 10 × 10^k) so the midline is whole too. */
export function niceCountCeil(value: number): number {
  if (value <= 2) return 2
  const exp = Math.floor(Math.log10(value))
  const base = 10 ** exp
  for (const m of [2, 4, 6, 8, 10]) {
    if (m * base >= value) return m * base
  }
  return 10 * base
}

/** "2026-11-23" → local Date (no UTC shift). */
export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}

const dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const dayLongFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' })

export function formatDay(day: string, long = false): string {
  return (long ? dayLongFmt : dayFmt).format(parseDay(day))
}
