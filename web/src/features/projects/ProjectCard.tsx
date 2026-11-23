import { Link, useNavigate } from 'react-router'
import { Archive, ClipboardList, MessageSquare, PenTool } from 'lucide-react'
import type { ProjectSummary } from '@/lib/types'
import { ROLE_LABELS } from '@/lib/status'
import { formatNumber, formatPercent, relativeTime, formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useRealtime } from '@/stores/realtime'
import { AvatarStack } from '@/components/ui/Avatar'
import { Badge, FormatBadge } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { Progress, Skeleton, Spinner } from '@/components/ui/Feedback'
import { Tooltip } from '@/components/ui/Tooltip'
import { StatusBar } from './StatusSegments'

/** One project on the home grid. The whole card is a link; actions sit above the link layer. */
export function ProjectCard({ project: p }: { project: ProjectSummary }) {
  const navigate = useNavigate()
  const indexing = useRealtime((s) => s.indexing[p.id])
  const isIndexing = p.indexing || (!!indexing && !indexing.finished)
  const done = p.status_counts.done ?? 0

  return (
    <article
      className={cn(
        'group relative flex flex-col gap-3 rounded-xl border border-line bg-panel p-4 shadow-card transition-[border-color,box-shadow] duration-150 hover:border-line-strong hover:shadow-pop focus-within:border-line-strong',
        p.archived && 'opacity-75',
      )}
    >
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-md font-semibold text-fg">
            <Link
              to={`/p/${p.id}`}
              className="rounded-sm after:absolute after:inset-0 after:rounded-xl after:content-[''] focus-visible:outline-none focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-accent"
            >
              {p.name}
            </Link>
          </h3>
          <p className="mt-0.5 line-clamp-2 min-h-[36px] text-sm text-muted">
            {p.description || <span className="text-dim">No description</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {p.archived && (
            <Badge variant="outline">
              <Archive aria-hidden />
              Archived
            </Badge>
          )}
          <FormatBadge format={p.label_format} />
        </div>
      </header>

      <div className="flex flex-col gap-1.5">
        <StatusBar counts={p.status_counts} total={p.image_count} size="thin" />
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">
            <span className="font-medium text-fg">{formatPercent(done, p.image_count)}</span> done
          </span>
          {isIndexing ? (
            <span className="flex items-center gap-1.5 text-muted">
              <Spinner className="size-3" label="Indexing" />
              Indexing
              {indexing && indexing.total > 0 && (
                <span className="tabular-nums">{formatPercent(indexing.done, indexing.total)}</span>
              )}
            </span>
          ) : (
            <span className="tabular-nums text-muted">{formatNumber(p.image_count)} images</span>
          )}
        </div>
        {isIndexing && indexing && indexing.total > 0 && (
          <Progress value={(indexing.done / indexing.total) * 100} className="h-1" label="Indexing progress" />
        )}
      </div>

      <div className="flex min-h-6 flex-wrap items-center gap-1.5">
        {p.my_assigned_todo > 0 && (
          <Badge variant="accent" size="md">
            <ClipboardList aria-hidden />
            {formatNumber(p.my_assigned_todo)} assigned to you
          </Badge>
        )}
        {p.unread_chat > 0 && (
          <Badge variant="warn" size="md">
            <MessageSquare aria-hidden />
            {p.unread_chat > 99 ? '99+' : p.unread_chat} unread
          </Badge>
        )}
      </div>

      <footer className="mt-auto flex items-center gap-2 border-t border-line pt-3">
        <AvatarStack users={p.members_preview ?? []} total={p.member_count} max={4} size="sm" />
        <div className="min-w-0 flex-1 truncate text-xs text-dim">
          {p.my_role ? ROLE_LABELS[p.my_role] : 'Administrator'}
          <span aria-hidden> · </span>
          <time dateTime={p.updated_at} title={formatDateTime(p.updated_at)}>
            Updated {relativeTime(p.updated_at)}
          </time>
        </div>
        <div className="relative z-10 flex items-center gap-0.5">
          <IconButton
            size="sm"
            label="Project chat"
            icon={<MessageSquare />}
            onClick={() => navigate(`/p/${p.id}`, { state: { openChat: true } })}
          />
          <Tooltip content="Open the annotator">
            <Link
              to={`/p/${p.id}/annotate`}
              className="inline-flex h-[26px] items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 text-xs font-medium text-fg hover:border-line-strong hover:bg-hover"
            >
              <PenTool className="size-3.5" aria-hidden />
              Annotate
            </Link>
          </Tooltip>
        </div>
      </footer>
    </article>
  )
}

export function ProjectCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4" aria-hidden>
      <div className="flex items-start justify-between">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-[18px] w-10" />
      </div>
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="h-1.5 w-full rounded-full" />
      <Skeleton className="h-3.5 w-24" />
      <div className="mt-2 flex items-center justify-between border-t border-line pt-3">
        <Skeleton className="h-6 w-20 rounded-full" />
        <Skeleton className="h-6 w-24" />
      </div>
    </div>
  )
}
