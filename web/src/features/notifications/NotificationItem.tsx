import { AtSign, Bell, CircleCheck, CircleX, ClipboardList, FolderPlus, Mail, MessageSquare, Search } from 'lucide-react'
import type { Notification, NotificationType } from '@/lib/types'
import { relativeTime, formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/Avatar'

const TYPE_ICONS: Record<NotificationType, typeof Bell> = {
  mention: AtSign,
  assignment: ClipboardList,
  review_approved: CircleCheck,
  review_rejected: CircleX,
  review_requested: Search,
  comment: MessageSquare,
  dm: Mail,
  project_added: FolderPlus,
}

const TYPE_TONES: Partial<Record<NotificationType, string>> = {
  review_approved: 'text-ok',
  review_rejected: 'text-danger',
  mention: 'text-warn',
  review_requested: 'text-warn',
}

interface NotificationItemProps {
  notification: Notification
  onOpen: (n: Notification) => void
  compact?: boolean
}

/** One notification row (button). Unread rows have a dot and stronger text. */
export function NotificationItem({ notification: n, onOpen, compact }: NotificationItemProps) {
  const Icon = TYPE_ICONS[n.type] ?? Bell
  const unread = !n.read_at
  return (
    <button
      type="button"
      onClick={() => onOpen(n)}
      className={cn(
        'group flex w-full items-start gap-3 rounded-md text-left transition-colors hover:bg-hover',
        compact ? 'px-2 py-2' : 'px-3 py-2.5',
      )}
    >
      <div className="relative mt-0.5 shrink-0">
        {n.actor ? (
          <Avatar user={n.actor} size="md" tooltip={false} />
        ) : (
          <div className="grid size-8 place-items-center rounded-full bg-panel-2 ring-1 ring-line">
            <Bell className="size-4 text-muted" />
          </div>
        )}
        <span className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full bg-elevated ring-1 ring-line">
          <Icon className={cn('size-2.5', TYPE_TONES[n.type] ?? 'text-muted')} aria-hidden />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className={cn('text-base leading-5', unread ? 'font-medium text-fg' : 'text-muted')}>{n.text}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-dim">
          {n.project && <span className="truncate">{n.project.name}</span>}
          {n.project && <span aria-hidden>·</span>}
          <time dateTime={n.created_at} title={formatDateTime(n.created_at)}>
            {relativeTime(n.created_at)}
          </time>
        </div>
      </div>
      {unread && <span className="mt-2 size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
    </button>
  )
}
