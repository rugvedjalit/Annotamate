import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Bell, CheckCheck } from 'lucide-react'
import { useMarkNotificationsRead } from '@/hooks/useMarkNotificationsRead'
import type { Notification } from '@/lib/types'
import { useNotifications } from '@/hooks/queries'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover'
import { Button } from '@/components/ui/Button'
import { CountBadge } from '@/components/ui/IconButton'
import { iconButtonVariants } from '@/components/ui/variants'
import { ErrorState, SkeletonRows } from '@/components/ui/Feedback'
import { Tooltip } from '@/components/ui/Tooltip'
import { NotificationItem } from '@/features/notifications/NotificationItem'
import { notificationHref, notificationState } from '@/features/notifications/notificationUtils'
import { cn } from '@/lib/utils'

export function NotificationsMenu() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const query = useNotifications(false)
  const markRead = useMarkNotificationsRead()
  const unread = query.data?.pages[0]?.unread_count ?? 0
  const items = query.data?.pages.flatMap((p) => p.items).slice(0, 30) ?? []

  function openItem(n: Notification) {
    if (!n.read_at) markRead.mutate({ ids: [n.id] })
    setOpen(false)
    const href = notificationHref(n)
    if (href) navigate(href, { state: notificationState(n) })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content="Notifications">
        <PopoverTrigger
          aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
          className={cn(iconButtonVariants({ size: 'md' }))}
        >
          <Bell />
          <CountBadge count={unread} />
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" className="flex max-h-[min(560px,80vh)] w-[380px] flex-col p-0">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
          <div className="text-base font-semibold">Notifications</div>
          {unread > 0 && <span className="text-xs text-muted">{unread} unread</span>}
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            disabled={unread === 0 || markRead.isPending}
            onClick={() => markRead.mutate({ all: true })}
          >
            <CheckCheck />
            Mark all read
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1">
          {query.isPending ? (
            <SkeletonRows rows={5} className="p-2" rowClassName="h-10" />
          ) : query.isError ? (
            <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
              <Bell className="size-5 text-dim" />
              <div className="text-sm font-medium">You're all caught up</div>
              <div className="text-xs text-muted">Mentions, assignments and review results show up here.</div>
            </div>
          ) : (
            items.map((n) => <NotificationItem key={n.id} notification={n} onOpen={openItem} compact />)
          )}
        </div>
        <div className="shrink-0 border-t border-line p-1">
          <Link
            to="/notifications"
            onClick={() => setOpen(false)}
            className="flex h-8 items-center justify-center rounded-md text-sm font-medium text-accent-text hover:bg-hover"
          >
            View all notifications
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  )
}
