import { ArrowDown } from 'lucide-react'
import type { UserBrief } from '@/lib/types'
import { formatDateTime, formatTime } from '@/lib/format'
import { Avatar } from '@/components/ui/Avatar'
import { typingText } from './thread'

export function DaySeparator({ label }: { label: string }) {
  return (
    <div className="sticky top-0 z-[1] flex items-center gap-3 py-2" role="separator" aria-label={label}>
      <div className="h-px flex-1 bg-line" />
      <span className="rounded-full border border-line bg-panel px-2.5 py-0.5 text-2xs font-semibold text-muted">
        {label}
      </span>
      <div className="h-px flex-1 bg-line" />
    </div>
  )
}

export function UnreadDivider() {
  return (
    <div className="flex items-center gap-3 py-1.5" role="separator" aria-label="New messages">
      <div className="h-px flex-1 bg-warn/60" />
      <span className="text-2xs font-semibold uppercase tracking-wider text-warn">New messages</span>
      <div className="h-px flex-1 bg-warn/60" />
    </div>
  )
}

export function JumpToLatest({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="absolute bottom-3 left-1/2 z-10 flex h-7 -translate-x-1/2 animate-pop-in items-center gap-1.5 rounded-full border border-line bg-elevated px-3 text-xs font-medium text-fg shadow-pop hover:bg-hover"
    >
      <ArrowDown className="size-3.5" aria-hidden />
      New messages below
    </button>
  )
}

export function TypingIndicator({ users }: { users: readonly UserBrief[] }) {
  const text = typingText(users)
  return (
    <div className="h-5 truncate px-4 text-xs text-muted" aria-live="polite">
      {text && (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex gap-0.5" aria-hidden>
            <span className="size-1 animate-shimmer rounded-full bg-muted" />
            <span className="size-1 animate-shimmer rounded-full bg-muted [animation-delay:150ms]" />
            <span className="size-1 animate-shimmer rounded-full bg-muted [animation-delay:300ms]" />
          </span>
          {text}
        </span>
      )}
    </div>
  )
}

/** Avatar + name + time header of a message group. */
export function MessageHeader({ user, createdAt, edited }: { user: UserBrief; createdAt: string; edited?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="truncate text-base font-semibold text-fg">{user.display_name}</span>
      <time dateTime={createdAt} title={formatDateTime(createdAt)} className="shrink-0 text-2xs text-dim">
        {formatTime(createdAt)}
      </time>
      {edited && <span className="text-2xs text-dim">(edited)</span>}
    </div>
  )
}

export function GroupAvatar({ user }: { user: UserBrief }) {
  return <Avatar user={user} size="md" tooltip={false} className="mt-0.5" />
}
