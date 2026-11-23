import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { bulkImages } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import { toFilterQuery, type ImageFilters } from '@/lib/filters'
import type { BulkBody } from '@/lib/types'
import { pluralize } from '@/lib/utils'

/** Column template shared by the header and the rows. */
export const GRID_COLS =
  'grid-cols-[40px_112px_minmax(220px,1fr)_60px_104px_150px_44px_80px_140px_92px]'
export const ROW_HEIGHT = 36
export const HEADER_HEIGHT = 34

export interface Selection {
  /** Filter key the selection belongs to (a filter change clears it). */
  key: string
  ids: ReadonlySet<number>
  /** "Select all N matching": bulk actions use the filter instead of ids. */
  all: boolean
  anchor: number | null
}

export function emptySelection(key: string): Selection {
  return { key, ids: new Set(), all: false, anchor: null }
}

/** Target part of a bulk request for the current selection. */
export function bulkTarget(sel: Selection, filters: ImageFilters): Pick<BulkBody, 'image_ids' | 'filter'> {
  return sel.all ? { filter: toFilterQuery(filters) } : { image_ids: [...sel.ids] }
}

/** Everything that may change after images are updated in bulk. */
export function invalidateAfterImageChanges(qc: QueryClient, projectId: number): void {
  for (const key of [
    qk.imagesAll(projectId),
    qk.neighborsAll(projectId),
    qk.stats(projectId),
    qk.project(projectId),
    qk.members(projectId),
    qk.projectsAll,
    qk.activityAll(projectId),
    ['project', projectId, 'image'],
  ]) {
    void qc.invalidateQueries({ queryKey: key })
  }
}

export function useBulkImages(projectId: number, onDone?: () => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ body }: { body: BulkBody; label: string }) => bulkImages(projectId, body),
    onSuccess: (res, { label }) => {
      toast.success(label, { description: `${pluralize(res.updated, 'image')} updated.` })
      invalidateAfterImageChanges(qc, projectId)
      onDone?.()
    },
    onError: (err) => toast.error('Bulk update failed', { description: errorMessage(err) }),
  })
}
