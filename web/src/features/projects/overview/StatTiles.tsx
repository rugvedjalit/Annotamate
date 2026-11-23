import type { ReactNode } from 'react'
import { Boxes, CircleCheck, Clock, Images, Wifi } from 'lucide-react'
import type { Project, ProjectStats } from '@/lib/types'
import { formatCompact, formatNumber, formatPercent } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useRealtime } from '@/stores/realtime'
import { AvatarStack } from '@/components/ui/Avatar'
import { Skeleton } from '@/components/ui/Feedback'

function Tile({
  label,
  value,
  sub,
  icon,
  children,
  title,
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  icon: ReactNode
  children?: ReactNode
  title?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-panel px-4 py-3.5 shadow-card" title={title}>
      <div className="flex items-center gap-1.5 text-sm text-muted [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className="text-[26px] font-semibold leading-8 tracking-tight text-fg">{value}</div>
      {sub && <div className="truncate text-xs text-muted">{sub}</div>}
      {children}
    </div>
  )
}

export function StatTilesSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-4 py-3.5">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  )
}

/** Headline numbers. Values use proportional figures (large standalone numbers). */
export function StatTiles({ project, stats }: { project: Project; stats: ProjectStats | undefined }) {
  const online = useRealtime((s) => s.onlineUserIds)
  const counts = stats?.status_counts ?? project.status_counts
  const total = stats?.images_total ?? project.image_count
  const done = counts.done ?? 0
  const review = counts.review ?? 0
  const onlineMembers = project.members.filter((m) => online.has(m.user.id))
  const classesUsed = stats?.class_counts.filter((c) => c.boxes > 0).length

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <Tile label="Images" icon={<Images />} value={formatCompact(total)} title={formatNumber(total)} sub={`${formatNumber(counts.todo ?? 0)} not started`} />
      <Tile label="Done" icon={<CircleCheck className="text-st-done" />} value={formatCompact(done)} title={formatNumber(done)} sub={`${formatPercent(done, total, 1)} of all images`}>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-ok-soft" aria-hidden>
          <div className="h-full rounded-full bg-st-done" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
      </Tile>
      <Tile
        label="In review"
        icon={<Clock className="text-st-review" />}
        value={formatCompact(review)}
        title={formatNumber(review)}
        sub={project.settings.require_review ? 'Waiting for a reviewer' : 'Review is optional in this project'}
      />
      <Tile
        label="Boxes"
        icon={<Boxes />}
        value={stats ? formatCompact(stats.boxes_total) : '…'}
        title={stats ? formatNumber(stats.boxes_total) : undefined}
        sub={classesUsed !== undefined ? `Across ${classesUsed} of ${project.classes.length} classes` : undefined}
      />
      <Tile label="Online now" icon={<Wifi />} value={formatNumber(onlineMembers.length)} sub={`of ${formatNumber(project.member_count)} members`}>
        <AvatarStack users={onlineMembers.map((m) => m.user)} size="xs" max={6} className={cn('mt-1', onlineMembers.length === 0 && 'hidden')} />
      </Tile>
    </div>
  )
}
