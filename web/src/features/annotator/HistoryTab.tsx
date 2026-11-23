import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, History, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { getRevision, getRevisions } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import { fromApiBoxes } from '@/lib/boxes'
import { formatDateTime, relativeTime } from '@/lib/format'
import type { RevisionSummary } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/Avatar'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { ErrorState, SkeletonRows } from '@/components/ui/Feedback'
import { useAnnotator } from './store'
import { useWorkspace } from './workspaceContext'

/** Saved revisions of this image (newest first): preview on the canvas, restore as a new save. */
export function HistoryTab() {
  const ws = useWorkspace()
  const qc = useQueryClient()
  const preview = useAnnotator((s) => s.preview)
  const setPreview = useAnnotator((s) => s.setPreview)
  const [busy, setBusy] = useState<number | null>(null)

  const query = useQuery({
    queryKey: qk.revisions(ws.projectId, ws.imageId),
    queryFn: ({ signal }) => getRevisions(ws.projectId, ws.imageId, { signal }),
    staleTime: 15_000,
  })

  async function loadBoxes(r: RevisionSummary) {
    const detail = await qc.fetchQuery({
      queryKey: qk.revision(ws.projectId, ws.imageId, r.id),
      queryFn: ({ signal }) => getRevision(ws.projectId, ws.imageId, r.id, { signal }),
      staleTime: Infinity,
    })
    return fromApiBoxes(detail.boxes)
  }

  const label = (r: RevisionSummary) => `the version from ${formatDateTime(r.created_at)}${r.user ? ` by ${r.user.display_name}` : ''}`

  async function showPreview(r: RevisionSummary) {
    setBusy(r.id)
    try {
      setPreview({ revisionId: r.id, boxes: await loadBoxes(r), label: label(r) })
    } catch (err) {
      toast.error('Could not load this revision', { description: errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  async function restore(r: RevisionSummary) {
    setBusy(r.id)
    try {
      const boxes = await loadBoxes(r)
      if (await ws.doc.restoreRevision(r.id, boxes)) {
        setPreview(null)
        toast.success('Revision restored', { description: 'Saved as a new version. Undo brings back the previous one.' })
      } else {
        toast.error('Save or resolve your current changes before restoring.')
      }
    } catch (err) {
      toast.error('Could not restore this revision', { description: errorMessage(err) })
    } finally {
      setBusy(null)
    }
  }

  if (query.isPending) return <SkeletonRows rows={6} className="p-3" rowClassName="h-12" />
  if (query.isError) return <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
  const revisions = query.data
  if (revisions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
        <History className="size-5 text-dim" aria-hidden />
        <div className="text-sm font-medium text-fg">No saved revisions yet</div>
        <div className="text-xs text-muted">Every save keeps a revision (the last 50 per image).</div>
      </div>
    )
  }

  return (
    <ul className="h-full divide-y divide-line/70 overflow-y-auto">
      {revisions.map((r, i) => {
        const current = r.version === ws.doc.state.baseVersion
        const previewing = preview?.revisionId === r.id
        return (
          <li key={r.id} className={cn('px-3 py-2.5', previewing && 'bg-accent-soft')}>
            <div className="flex items-center gap-2">
              {r.user ? <Avatar user={r.user} size="sm" /> : <span className="size-6 rounded-full bg-hover" aria-hidden />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-sm">
                  <span className="truncate font-medium text-fg">{r.user?.display_name ?? 'External change'}</span>
                  {current && <Badge variant="ok">Current</Badge>}
                  {i === 0 && !current && <Badge variant="neutral">Latest</Badge>}
                </div>
                <div className="text-xs text-dim">
                  <time dateTime={r.created_at} title={formatDateTime(r.created_at)}>
                    {relativeTime(r.created_at)}
                  </time>
                  {' · '}
                  <span title={`Version ${r.version}`}>
                    {r.box_count} box{r.box_count === 1 ? '' : 'es'}
                  </span>
                </div>
              </div>
            </div>
            <div className="mt-2 flex gap-1.5 pl-8">
              {previewing ? (
                <Button size="xs" variant="ghost" onClick={() => setPreview(null)}>
                  Exit preview
                </Button>
              ) : (
                <Button size="xs" variant="ghost" loading={busy === r.id && !preview} disabled={busy !== null} onClick={() => void showPreview(r)}>
                  <Eye />
                  Preview
                </Button>
              )}
              {!current && ws.editable && (
                <Button size="xs" variant="secondary" disabled={busy !== null} onClick={() => void restore(r)}>
                  <RotateCcw />
                  Restore
                </Button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
