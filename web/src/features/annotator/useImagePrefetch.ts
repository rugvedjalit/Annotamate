// Prefetch the previous/next 2 images (detail, decoded bitmap, annotation) and cancel stale prefetches.
import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { assetUrl } from '@/lib/config'
import { getAnnotation, getImage, getNeighbors } from '@/lib/endpoints'
import type { ImageFilters } from '@/lib/filters'
import { imageCache } from '@/lib/imageCache'
import { qk } from '@/lib/queryKeys'
import type { ImageDetail, Neighbors } from '@/lib/types'

export function useImagePrefetch(
  projectId: number,
  current: ImageDetail | undefined,
  neighbors: Neighbors | undefined,
  filters: ImageFilters,
): void {
  const qc = useQueryClient()
  const prevId = neighbors?.prev_id ?? null
  const nextId = neighbors?.next_id ?? null
  const currentId = current?.id ?? null
  const currentUrl = current && !current.error ? assetUrl(current.file_url) : null

  // Second ring (±2) via the neighbours of the neighbours.
  const nextNext = useQuery({
    queryKey: qk.neighbors(projectId, nextId ?? -1, filters),
    queryFn: ({ signal }) => getNeighbors(projectId, nextId!, filters, { signal }),
    enabled: nextId !== null && currentId !== null,
    staleTime: 30_000,
  })
  const prevPrev = useQuery({
    queryKey: qk.neighbors(projectId, prevId ?? -1, filters),
    queryFn: ({ signal }) => getNeighbors(projectId, prevId!, filters, { signal }),
    enabled: prevId !== null && currentId !== null,
    staleTime: 30_000,
  })
  const next2 = nextNext.data?.next_id ?? null
  const prev2 = prevPrev.data?.prev_id ?? null

  useEffect(() => {
    if (currentId === null) return
    const ids = [nextId, prevId, next2, prev2].filter((id): id is number => id !== null && id !== currentId)
    let cancelled = false
    const keep = new Set<string>(currentUrl ? [currentUrl] : [])

    for (const id of ids) {
      void qc
        .fetchQuery({
          queryKey: qk.image(projectId, id),
          queryFn: ({ signal }) => getImage(projectId, id, { signal }),
          staleTime: 60_000,
        })
        .then((detail) => {
          if (cancelled || detail.error) return
          const url = assetUrl(detail.file_url)
          keep.add(url)
          imageCache.prefetch(url)
        })
        .catch(() => undefined)
      void qc.prefetchQuery({
        queryKey: qk.annotation(projectId, id),
        queryFn: ({ signal }) => getAnnotation(projectId, id, { signal }),
        staleTime: 15_000,
      })
    }
    // Abort background loads for images that are no longer neighbours.
    for (const id of ids) {
      const d = qc.getQueryData<ImageDetail>(qk.image(projectId, id))
      if (d) keep.add(assetUrl(d.file_url))
    }
    imageCache.cancelPrefetchesExcept(keep)
    return () => {
      cancelled = true
    }
  }, [qc, projectId, currentId, currentUrl, nextId, prevId, next2, prev2])
}
