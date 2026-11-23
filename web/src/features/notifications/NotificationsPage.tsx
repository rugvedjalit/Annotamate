import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { Bell, CheckCheck } from 'lucide-react'
import type { Notification } from '@/lib/types'
import { dayLabel, isSameDay } from '@/lib/format'
import { useNotifications } from '@/hooks/queries'
import { useMarkNotificationsRead } from '@/hooks/useMarkNotificationsRead'
import { Button } from '@/components/ui/Button'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/ui/Feedback'
import { NotificationItem } from './NotificationItem'
import { notificationHref, notificationState } from './notificationUtils'

type Filter = 'all' | 'unread'

export function NotificationsPage() {
  const [filter, setFilter] = useState<Filter>('all')
  const query = useNotifications(filter === 'unread')
  const markRead = useMarkNotificationsRead()
  const navigate = useNavigate()
  const unread = query.data?.pages[0]?.unread_count ?? 0

  const groups = useMemo(() => {
    const items = query.data?.pages.flatMap((p) => p.items) ?? []
    const out: { label: string; items: Notification[] }[] = []
    for (const n of items) {
      const g = out[out.length - 1]
      if (g && g.items[0] && isSameDay(g.items[0].created_at, n.created_at)) g.items.push(n)
      else out.push({ label: dayLabel(n.created_at), items: [n] })
    }
    return out
  }, [query.data])

  function open(n: Notification) {
    if (!n.read_at) markRead.mutate({ ids: [n.id] })
    const href = notificationHref(n)
    if (href) navigate(href, { state: notificationState(n) })
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Notifications</h1>
          <p className="text-sm text-muted">
            {unread > 0 ? `${unread} unread` : 'Mentions, assignments, review results and messages.'}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <SegmentedControl
            aria-label="Show"
            value={filter}
            onValueChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'unread', label: 'Unread' },
            ]}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={unread === 0 || markRead.isPending}
            onClick={() => markRead.mutate({ all: true })}
          >
            <CheckCheck />
            Mark all read
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-line bg-panel shadow-card">
        {query.isPending ? (
          <SkeletonRows rows={6} className="p-4" rowClassName="h-12" />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : groups.length === 0 ? (
          <EmptyState
            icon={<Bell />}
            title={filter === 'unread' ? 'No unread notifications' : "You're all caught up"}
            description="When someone mentions you, assigns you images or reviews your work, it shows up here."
          />
        ) : (
          <div className="divide-y divide-line">
            {groups.map((g) => (
              <section key={`${g.label}-${g.items[0]?.id}`} aria-label={g.label} className="p-2">
                <h2 className="px-3 pb-1 pt-2 text-2xs font-semibold uppercase tracking-wider text-dim">{g.label}</h2>
                {g.items.map((n) => (
                  <NotificationItem key={n.id} notification={n} onOpen={open} />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>

      {query.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button variant="secondary" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            Load older notifications
          </Button>
        </div>
      )}
    </div>
  )
}
