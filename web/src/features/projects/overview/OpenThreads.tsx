import { Link } from 'react-router'
import { useInfiniteQuery } from '@tanstack/react-query'
import { MapPin, MessageCircle } from 'lucide-react'
import { getProjectComments } from '@/lib/endpoints'
import { qk } from '@/lib/queryKeys'
import { formatDateTime, relativeTime } from '@/lib/format'
import type { Member } from '@/lib/types'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/ui/Feedback'
import { MessageBody } from '@/components/MessageBody'

const PAGE = 20

/** Unresolved image comments across the project, newest first. */
export function OpenThreads({ projectId, members }: { projectId: number; members: Member[] }) {
  const query = useInfiniteQuery({
    queryKey: qk.threads(projectId),
    queryFn: ({ pageParam, signal }) =>
      getProjectComments(projectId, { resolved: false, before_id: pageParam, limit: PAGE }, { signal }),
    initialPageParam: undefined as number | undefined,
    // Pages are ascending inside; the oldest id of a page is the cursor for the next (older) page.
    getNextPageParam: (last) => (last.has_more ? last.items[0]?.id : undefined),
    staleTime: 20_000,
  })
  const usernames = new Set(members.map((m) => m.user.username))

  if (query.isPending) return <SkeletonRows rows={3} rowClassName="h-14" />
  if (query.isError) return <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />

  const items = query.data.pages.flatMap((p) => [...p.items].reverse()).filter((c) => !c.deleted)
  if (items.length === 0) {
    return (
      <EmptyState
        compact
        icon={<MessageCircle />}
        title="No open threads"
        description="Unresolved comments on images show up here."
      />
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <ul className="-mx-2 flex flex-col">
        {items.map((c) => (
          <li key={c.id}>
            <Link
              to={`/p/${projectId}/annotate/${c.image.id}`}
              className="flex gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-hover"
            >
              <Avatar user={c.user} size="sm" tooltip={false} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5 text-xs">
                  <span className="truncate font-medium text-fg">{c.user.display_name}</span>
                  <span className="text-dim">on</span>
                  <span className="min-w-0 truncate font-mono text-muted">{c.image.filename}</span>
                  {c.pin && <MapPin className="size-3 shrink-0 text-warn" aria-label="Pinned on the image" />}
                  <time
                    dateTime={c.created_at}
                    title={formatDateTime(c.created_at)}
                    className="ml-auto shrink-0 text-dim"
                  >
                    {relativeTime(c.created_at)}
                  </time>
                </div>
                <MessageBody body={c.body} usernames={usernames} className="mt-0.5 line-clamp-3 text-sm" />
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {query.hasNextPage && (
        <Button variant="ghost" size="sm" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          Load more
        </Button>
      )}
    </div>
  )
}
