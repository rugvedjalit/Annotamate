import { Fragment } from 'react'
import { Link } from 'react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { Activity as ActivityIcon } from 'lucide-react'
import { getActivity } from '@/lib/endpoints'
import { qk } from '@/lib/queryKeys'
import type { Activity } from '@/lib/types'
import { dayLabel, formatDateTime, isSameDay, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/Feedback'
import { ACTIVITY_ICONS, describeActivity } from './describeActivity'

interface ActivityFeedProps {
  projectId: number
  imageId?: number
  userId?: number
  /** Dense rows without day separators (inspector panels). */
  compact?: boolean
  pageSize?: number
  className?: string
}

function ActivityRow({ a, projectId, compact, hideImage }: { a: Activity; projectId: number; compact?: boolean; hideImage?: boolean }) {
  const { before, after } = describeActivity(a)
  const Icon = ACTIVITY_ICONS[a.type] ?? ActivityIcon
  return (
    <li className={cn('flex items-start gap-2.5', compact ? 'py-1.5' : 'py-2')}>
      <div className="relative mt-0.5 shrink-0">
        {a.user ? (
          <Avatar user={a.user} size={compact ? 'xs' : 'sm'} />
        ) : (
          <div
            className={cn(
              'grid place-items-center rounded-full bg-panel-2 ring-1 ring-line',
              compact ? 'size-[18px]' : 'size-6',
            )}
          >
            <Icon className="size-3 text-muted" aria-hidden />
          </div>
        )}
        {a.user && !compact && (
          <span className="absolute -bottom-1 -right-1 grid size-3.5 place-items-center rounded-full bg-panel ring-1 ring-line">
            <Icon className="size-2 text-muted" aria-hidden />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn('leading-5 text-muted', compact ? 'text-sm' : 'text-base')}>
          <span className="font-medium text-fg">{a.user?.display_name ?? 'Annotamate'}</span> {before}
          {a.image &&
            (hideImage ? (
              // The feed is already about this image: no link to itself.
              <> this image</>
            ) : (
              <>
                {' '}
                <Link
                  to={`/p/${projectId}/annotate/${a.image.id}`}
                  title={a.image.filename}
                  className="inline-block max-w-full truncate whitespace-nowrap align-bottom font-mono text-[0.95em] text-fg underline decoration-line-strong underline-offset-2 hover:text-accent-text hover:decoration-accent-text"
                >
                  {a.image.filename}
                </Link>
              </>
            ))}
          {after && <>{/^[,.:;]/.test(after) ? '' : ' '}{after}</>}
        </p>
        <time
          dateTime={a.created_at}
          title={formatDateTime(a.created_at)}
          className={cn('block text-dim', compact ? 'text-2xs' : 'text-xs')}
        >
          {relativeTime(a.created_at)}
        </time>
      </div>
    </li>
  )
}

/** Live project activity (newest first), optionally scoped to one image or one person. */
export function ActivityFeed({ projectId, imageId, userId, compact, pageSize = 30, className }: ActivityFeedProps) {
  const filter: { image_id?: number; user_id?: number } = {}
  if (imageId !== undefined) filter.image_id = imageId
  if (userId !== undefined) filter.user_id = userId

  const query = useInfiniteQuery({
    queryKey: qk.activity(projectId, filter),
    queryFn: ({ pageParam, signal }) =>
      getActivity(projectId, { ...filter, before_id: pageParam, limit: pageSize }, { signal }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.has_more ? last.items[last.items.length - 1]?.id : undefined),
    staleTime: 15_000,
  })

  if (query.isPending) {
    return (
      <div className={cn('flex flex-col gap-3', compact ? 'py-1' : 'py-2', className)} role="status" aria-label="Loading activity">
        {Array.from({ length: compact ? 4 : 6 }, (_, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <Skeleton className={cn('shrink-0 rounded-full', compact ? 'size-[18px]' : 'size-6')} />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
        ))}
      </div>
    )
  }
  if (query.isError) {
    return <ErrorState compact className={className} title="Could not load activity" error={query.error} onRetry={() => void query.refetch()} />
  }

  const items = query.data.pages.flatMap((p) => p.items)
  if (items.length === 0) {
    return (
      <EmptyState
        compact
        className={className}
        icon={<ActivityIcon />}
        title="No activity yet"
        description={imageId !== undefined ? 'Saves, status changes and comments on this image appear here.' : 'Saves, reviews, assignments and comments appear here as they happen.'}
      />
    )
  }

  return (
    <div className={className}>
      <ol className="flex flex-col">
        {items.map((a, i) => {
          const prev = items[i - 1]
          const newDay = !compact && (!prev || !isSameDay(prev.created_at, a.created_at))
          return (
            <Fragment key={a.id}>
              {newDay && (
                <li aria-hidden className="pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-dim first:pt-0">
                  {dayLabel(a.created_at)}
                </li>
              )}
              <ActivityRow a={a} projectId={projectId} compact={compact} hideImage={imageId !== undefined} />
            </Fragment>
          )
        })}
      </ol>
      {query.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-1 w-full"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          Load more
        </Button>
      )}
    </div>
  )
}
