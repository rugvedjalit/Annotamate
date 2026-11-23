import { RefreshCw } from 'lucide-react'
import type { Project } from '@/lib/types'
import { formatNumber, formatPercent } from '@/lib/format'
import { useRealtime } from '@/stores/realtime'
import { Progress, Spinner } from '@/components/ui/Feedback'

/** Shown while the server scans the project folder (progress arrives over the WebSocket). */
export function IndexingBanner({ project }: { project: Project }) {
  const progress = useRealtime((s) => s.indexing[project.id])
  const running = progress ? !progress.finished : project.indexing
  if (!running && !progress?.finished) return null

  if (progress?.finished) {
    return (
      <div role="status" className="flex items-center gap-2 rounded-lg border border-ok/30 bg-ok-soft px-4 py-2.5 text-sm text-fg">
        <RefreshCw className="size-4 text-ok" aria-hidden />
        Indexing finished: {formatNumber(progress.total)} images scanned.
      </div>
    )
  }

  const known = progress && progress.total > 0
  return (
    <div role="status" className="flex flex-col gap-2 rounded-lg border border-accent/30 bg-accent-soft px-4 py-3 text-sm">
      <div className="flex items-center gap-2 text-fg">
        <Spinner className="size-3.5 text-accent-text" label="Indexing" />
        <span className="font-medium">Indexing images…</span>
        {known && (
          <span className="ml-auto tabular-nums text-muted">
            {formatNumber(progress.done)} of {formatNumber(progress.total)} · {formatPercent(progress.done, progress.total)}
          </span>
        )}
      </div>
      {known ? (
        <Progress value={(progress.done / progress.total) * 100} label="Indexing progress" />
      ) : (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-hover" aria-hidden>
          <div className="h-full w-1/3 animate-shimmer rounded-full bg-accent" />
        </div>
      )}
      <p className="text-xs text-muted">New images appear in the list as soon as they are found. You can start annotating meanwhile.</p>
    </div>
  )
}
