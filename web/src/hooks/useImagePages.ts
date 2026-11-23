// Windowed image list: rows load in pages (default 200) keyed by offset, only for the visible range.
// Works for 100k+ images with a virtualiser: call setVisibleRange() with the rendered index range.
import { useCallback, useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import { getImages } from '@/lib/endpoints'
import type { ImageFilters } from '@/lib/filters'
import { IMAGE_PAGE_SIZE, qk } from '@/lib/queryKeys'
import type { ImageItem } from '@/lib/types'

export interface ImagePages {
  /** Total rows matching the filter (undefined until the first page arrives). */
  total: number | undefined
  /** Row at an absolute index, or undefined while its page loads. */
  getItem: (index: number) => ImageItem | undefined
  /** Tell the hook which rows are rendered (inclusive). Pages ±1 around them are loaded. */
  setVisibleRange: (start: number, end: number) => void
  isPending: boolean
  error: unknown
  refetch: () => void
  /** All rows loaded so far (for "select loaded" and lookups). */
  loadedItems: () => ImageItem[]
}

export function useImagePages(projectId: number, filters: ImageFilters, pageSize = IMAGE_PAGE_SIZE): ImagePages {
  const [window, setWindow] = useState<[number, number]>([0, 0])

  const pageIndexes = useMemo(() => {
    const set = new Set<number>([0])
    for (let p = Math.max(0, window[0] - 1); p <= window[1] + 1; p++) set.add(p)
    return [...set].sort((a, b) => a - b)
  }, [window])

  const results = useQueries({
    queries: pageIndexes.map((page) => ({
      queryKey: qk.imagesPage(projectId, filters, page, pageSize),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getImages(projectId, filters, page * pageSize, pageSize, { signal }),
      staleTime: 30_000,
    })),
  })

  const total = results[0]?.data?.total
  const lastPage = total !== undefined ? Math.max(0, Math.ceil(total / pageSize) - 1) : Infinity

  const pages = new Map<number, ImageItem[]>()
  pageIndexes.forEach((p, i) => {
    const items = results[i]?.data?.items
    if (items) pages.set(p, items)
  })
  const pagesKey = results.map((r) => r.dataUpdatedAt).join(',')

  // eslint-disable-next-line react-hooks/exhaustive-deps -- pagesKey captures every page's data identity
  const getItem = useCallback((index: number) => pages.get(Math.floor(index / pageSize))?.[index % pageSize], [pagesKey, pageSize])

  const setVisibleRange = useCallback(
    (start: number, end: number) => {
      const a = Math.min(Math.floor(Math.max(start, 0) / pageSize), lastPage)
      const b = Math.min(Math.floor(Math.max(end, 0) / pageSize), lastPage)
      setWindow((w) => (w[0] === a && w[1] === b ? w : [a, b]))
    },
    [pageSize, lastPage],
  )

  const first = results[0]
  return {
    total,
    getItem,
    setVisibleRange,
    isPending: !!first?.isPending,
    error: first?.error ?? null,
    refetch: () => {
      for (const r of results) void r.refetch()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see getItem
    loadedItems: useCallback(() => [...pages.values()].flat(), [pagesKey]),
  }
}
