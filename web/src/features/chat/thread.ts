// Shared thread logic for project chat and direct messages: row building (day separators, grouping,
// unread divider) and typing-indicator text.
import { dayLabel, isSameDay, parseDate } from '@/lib/format'
import type { UserBrief } from '@/lib/types'

/** Consecutive messages by the same author within this window share one header. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000

export const CHAT_PAGE_SIZE = 50

export type ThreadRow<T> =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | { kind: 'message'; key: string; message: T; showHeader: boolean }

interface ThreadMessageLike {
  id: number
  created_at: string
}

/**
 * Turn ascending messages into rows: a day separator whenever the day changes, an optional "New messages"
 * divider before `firstUnreadId`, and `showHeader` on the first message of each author group.
 */
export function buildThreadRows<T extends ThreadMessageLike>(
  messages: readonly T[],
  authorOf: (m: T) => number,
  firstUnreadId: number | null = null,
  now: Date = new Date(),
): ThreadRow<T>[] {
  const rows: ThreadRow<T>[] = []
  let prev: T | null = null
  for (const m of messages) {
    let breakGroup = false
    if (!prev || !isSameDay(prev.created_at, m.created_at)) {
      rows.push({ kind: 'day', key: `day-${m.id}`, label: dayLabel(m.created_at, now) })
      breakGroup = true
    }
    if (firstUnreadId !== null && m.id === firstUnreadId) {
      rows.push({ kind: 'unread', key: `unread-${m.id}` })
      breakGroup = true
    }
    if (prev && !breakGroup) {
      const gap = (parseDate(m.created_at)?.getTime() ?? 0) - (parseDate(prev.created_at)?.getTime() ?? 0)
      breakGroup = authorOf(prev) !== authorOf(m) || gap > GROUP_WINDOW_MS
    }
    rows.push({ kind: 'message', key: `m-${m.id}`, message: m, showHeader: !prev || breakGroup })
    prev = m
  }
  return rows
}

/** "Alice is typing…", "Alice and Bob are typing…", "Several people are typing…" */
export function typingText(users: readonly Pick<UserBrief, 'display_name'>[]): string | null {
  if (users.length === 0) return null
  if (users.length === 1) return `${users[0]!.display_name} is typing…`
  if (users.length === 2) return `${users[0]!.display_name} and ${users[1]!.display_name} are typing…`
  return 'Several people are typing…'
}

/** Throttle helper for typing notifications (returns true when a frame should be sent now). */
export function shouldSendTyping(lastSentAt: number, now: number, intervalMs = 3000): boolean {
  return now - lastSentAt >= intervalMs
}
