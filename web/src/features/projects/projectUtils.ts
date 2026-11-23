// Small helpers shared by the project pages.
import type { ImageStatus, StatusCounts } from '@/lib/types'
import { IMAGE_STATUSES } from '@/lib/types'
import { STATUS_ORDER } from '@/lib/status'

export function totalOf(counts: StatusCounts): number {
  return IMAGE_STATUSES.reduce((sum, s) => sum + (counts[s] ?? 0), 0)
}

export interface StatusSegment {
  status: ImageStatus
  count: number
  /** 0..100 */
  share: number
}

/** Non-empty status parts in display order, with their share of the total. */
export function statusSegments(counts: StatusCounts, total = totalOf(counts)): StatusSegment[] {
  if (total <= 0) return []
  return STATUS_ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => ({
    status: s,
    count: counts[s],
    share: (counts[s] / total) * 100,
  }))
}

/** Last path segment of a server folder (handles "/" and "\" separators). */
export function folderBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts[parts.length - 1] || trimmed
}

export const SETTINGS_TABS = ['general', 'classes', 'members', 'workflow', 'danger'] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]

export function isSettingsTab(v: string | undefined): v is SettingsTab {
  return !!v && (SETTINGS_TABS as readonly string[]).includes(v)
}
