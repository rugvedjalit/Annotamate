import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ImageOff, Images, SearchX, Shuffle } from 'lucide-react'
import { toast } from 'sonner'
import { updateImage } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { upsertImageItem } from '@/lib/cacheUpdates'
import { filtersFromParams, filtersToParams, hasActiveFilters, toFilterQuery, type ImageFilters } from '@/lib/filters'
import { formatNumber } from '@/lib/format'
import type { ImageItem } from '@/lib/types'
import { cn, mapLimit, pluralize } from '@/lib/utils'
import { useProjectContext } from '@/app/projectContext'
import { useImagePages } from '@/hooks/useImagePages'
import { useSession } from '@/stores/session'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { EmptyState, ErrorState } from '@/components/ui/Feedback'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ImageFiltersBar } from './images/ImageFiltersBar'
import { ImageRow } from './images/ImageRow'
import { SelectionBar } from './images/SelectionBar'
import { DistributeDialog } from './images/DistributeDialog'
import { UploadButton } from './images/UploadButton'
import { ExportPopover } from './images/ExportPopover'
import { CLASS_MIGRATION_HINT, useClassMigration } from './useClassMigration'
import {
  GRID_COLS,
  HEADER_HEIGHT,
  ROW_HEIGHT,
  bulkTarget,
  emptySelection,
  invalidateAfterImageChanges,
  useBulkImages,
  type Selection,
} from './images/imagesTableUtils'

const HEADERS = ['', 'Status', 'File', 'Boxes', 'Classes', 'Assignee', 'Flag', 'Comments', 'Last editor', 'Updated'] as const

/** Virtualised, filterable table of every image in the project, with bulk actions. */
export function ImagesTablePage() {
  const { projectId, project } = useProjectContext()
  const me = useSession((s) => s.user)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => filtersFromParams(params), [params])
  const filterKey = JSON.stringify(toFilterQuery(filters))
  const pages = useImagePages(projectId, filters)
  const total = pages.total
  const perms = project.permissions
  const pausedReason = useClassMigration(project) ? CLASS_MIGRATION_HINT : undefined
  const classesById = useMemo(() => new Map(project.classes.map((c) => [c.id, c])), [project.classes])

  const [rawSelection, setSelection] = useState<Selection>(() => emptySelection(filterKey))
  const selection = rawSelection.key === filterKey ? rawSelection : emptySelection(filterKey)
  const [focusIndex, setFocusIndex] = useState(0)
  const [distributing, setDistributing] = useState(false)
  const [claiming, setClaiming] = useState(false)

  const setFilters = useCallback(
    (next: ImageFilters) => setParams(filtersToParams(next, params), { replace: true }),
    [params, setParams],
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  // The virtualizer returns fresh functions each render by design; this component is not compiler-memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: total ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
    scrollMargin: HEADER_HEIGHT,
  })
  const vItems = virtualizer.getVirtualItems()
  const first = vItems[0]?.index ?? 0
  const last = vItems[vItems.length - 1]?.index ?? 0
  const { setVisibleRange } = pages
  useEffect(() => setVisibleRange(first, last), [first, last, setVisibleRange])

  // Scroll back to the top when the filter changes.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [filterKey])

  const clearSelection = () => setSelection(emptySelection(filterKey))
  const bulk = useBulkImages(projectId, clearSelection)

  const loaded = pages.loadedItems()
  const loadedSelected = loaded.filter((i) => selection.ids.has(i.id)).length
  const selectedCount = selection.all ? (total ?? 0) : selection.ids.size
  const headerState: boolean | 'indeterminate' =
    selection.all || (loaded.length > 0 && loadedSelected === loaded.length)
      ? true
      : selection.ids.size > 0
        ? 'indeterminate'
        : false

  function toggleRow(index: number, item: ImageItem, shift: boolean) {
    setSelection((prev0) => {
      const prev = prev0.key === filterKey ? prev0 : emptySelection(filterKey)
      // Leaving "all matching" mode: start from the loaded rows.
      const ids = new Set(prev.all ? loaded.map((i) => i.id) : prev.ids)
      const on = !ids.has(item.id)
      const [a, b] = shift && prev.anchor !== null ? (prev.anchor < index ? [prev.anchor, index] : [index, prev.anchor]) : [index, index]
      for (let i = a; i <= b; i++) {
        const it = i === index ? item : pages.getItem(i)
        if (!it) continue
        if (on) ids.add(it.id)
        else ids.delete(it.id)
      }
      return { key: filterKey, ids, all: false, anchor: index }
    })
  }

  function toggleHeader() {
    if (headerState === false) setSelection({ key: filterKey, ids: new Set(loaded.map((i) => i.id)), all: false, anchor: null })
    else clearSelection()
  }

  const openImage = useCallback(
    (item: ImageItem) => {
      const qs = filtersToParams(filters).toString()
      navigate(`/p/${projectId}/annotate/${item.id}${qs ? `?${qs}` : ''}`)
    },
    [filters, navigate, projectId],
  )

  function focusRow(i: number) {
    if (total === undefined || total === 0) return
    const target = Math.min(Math.max(i, 0), total - 1)
    setFocusIndex(target)
    virtualizer.scrollToIndex(target, { align: 'auto' })
    requestAnimationFrame(() =>
      scrollRef.current?.querySelector<HTMLElement>(`[data-row-index="${target}"]`)?.focus({ preventScroll: true }),
    )
  }

  function onRowKeyDown(e: KeyboardEvent<HTMLDivElement>, index: number, item: ImageItem | undefined) {
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 400) / ROW_HEIGHT) - 1)
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusRow(index + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        focusRow(index - 1)
        break
      case 'PageDown':
        e.preventDefault()
        focusRow(index + page)
        break
      case 'PageUp':
        e.preventDefault()
        focusRow(index - page)
        break
      case 'Home':
        e.preventDefault()
        focusRow(0)
        break
      case 'End':
        e.preventDefault()
        focusRow((total ?? 1) - 1)
        break
      case 'Enter':
        if (item) {
          e.preventDefault()
          openImage(item)
        }
        break
      case ' ':
        if (item) {
          e.preventDefault()
          toggleRow(index, item, e.shiftKey)
        }
        break
    }
  }

  const claimableIds = selection.all ? [] : loaded.filter((i) => selection.ids.has(i.id) && !i.assignee).map((i) => i.id)

  async function claim() {
    if (!me || claimableIds.length === 0) return
    setClaiming(true)
    const results = await mapLimit(claimableIds, 4, (id) => updateImage(projectId, id, { assignee_id: me.id }))
    setClaiming(false)
    let ok = 0
    let firstError: unknown = null
    for (const r of results) {
      if (r.status === 'fulfilled') {
        ok++
        upsertImageItem(qc, projectId, r.value)
      } else firstError ??= r.reason
    }
    if (ok) toast.success(`Claimed ${pluralize(ok, 'image')}`)
    if (firstError) toast.error(`Could not claim ${pluralize(results.length - ok, 'image')}`, { description: errorMessage(firstError) })
    invalidateAfterImageChanges(qc, projectId)
    clearSelection()
  }

  const target = selectedCount > 0 ? bulkTarget(selection, filters) : { filter: toFilterQuery(filters) }
  const targetCount = selectedCount > 0 ? selectedCount : (total ?? 0)
  const filtered = hasActiveFilters(filters)

  let body: ReactNode = null
  if (pages.isPending) {
    body = null
  } else if (pages.error) {
    body = <ErrorState title="Could not load images" error={pages.error} onRetry={pages.refetch} />
  } else if (total === 0) {
    body = filtered ? (
      <EmptyState
        icon={<SearchX />}
        title="No images match these filters"
        description="Try fewer filters or a different search."
        action={
          <Button variant="secondary" onClick={() => setFilters({ sort: filters.sort })}>
            Clear filters
          </Button>
        }
      />
    ) : (
      <EmptyState
        icon={<ImageOff />}
        title="No images in this project yet"
        description={
          project.indexing
            ? 'The folder is still being indexed. Images appear here as they are found.'
            : perms.can_manage
              ? 'Upload images or add files to the project folder and rescan.'
              : 'A manager can add images to this project.'
        }
        action={perms.can_manage ? <UploadButton projectId={projectId} disabledReason={pausedReason} /> : undefined}
      />
    )
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-[1320px] flex-col gap-3 px-6 pb-4 pt-5">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-baseline gap-2 text-lg font-semibold tracking-tight text-fg">
            <Images className="size-4 self-center text-muted" aria-hidden />
            Images
            {total !== undefined && (
              <span className="text-base font-normal tabular-nums text-dim">
                {filtered ? `${formatNumber(total)} of ${formatNumber(project.image_count)}` : formatNumber(total)}
              </span>
            )}
          </h1>
        </div>
        {perms.can_manage && (
          <>
            <Button variant="secondary" onClick={() => setDistributing(true)} disabled={!total}>
              <Shuffle />
              Distribute…
            </Button>
            <UploadButton projectId={projectId} disabledReason={pausedReason} />
            <ExportPopover projectId={projectId} defaultFormat={project.label_format} disabledReason={pausedReason} />
          </>
        )}
      </header>

      <ImageFiltersBar
        filters={filters}
        onChange={setFilters}
        members={project.members}
        classes={project.classes}
        total={project.image_count}
      />

      {selectedCount > 0 && (
        <SelectionBar
          count={selectedCount}
          total={total}
          allMatching={selection.all}
          canSelectAllMatching={
            perms.can_manage && !selection.all && total !== undefined && loaded.length > 0 && loadedSelected === loaded.length && total > loaded.length
          }
          onSelectAllMatching={() => setSelection({ key: filterKey, ids: new Set(), all: true, anchor: null })}
          onClear={clearSelection}
          canManage={perms.can_manage}
          members={project.members}
          busy={bulk.isPending || claiming}
          onBulk={(b, label) => bulk.mutate({ body: { ...b, ...bulkTarget(selection, filters) }, label })}
          onDistribute={() => setDistributing(true)}
          claimable={claimableIds.length}
          onClaim={perms.can_edit ? () => void claim() : undefined}
        />
      )}

      <ErrorBoundary name="Images table" className="flex-1">
        <div
          ref={scrollRef}
          role="grid"
          aria-label="Images"
          aria-rowcount={(total ?? 0) + 1}
          aria-multiselectable
          className="relative min-h-0 flex-1 overflow-auto rounded-lg border border-line bg-panel"
        >
          <div className="min-w-[1080px]">
            <div
              role="row"
              className={cn(
                'sticky top-0 z-10 grid items-center border-b border-line bg-panel-2 text-xs font-medium text-muted',
                GRID_COLS,
              )}
              style={{ height: HEADER_HEIGHT }}
            >
              <div role="columnheader" className="flex items-center justify-center px-2">
                <Checkbox
                  aria-label={headerState ? 'Clear selection' : 'Select all loaded rows'}
                  checked={headerState}
                  disabled={!total}
                  onCheckedChange={toggleHeader}
                />
              </div>
              {HEADERS.slice(1).map((h) => (
                <div key={h} role="columnheader" className={cn('truncate px-2', h === 'Boxes' && 'text-right')}>
                  {h}
                </div>
              ))}
            </div>
            {pages.isPending ? (
              <div aria-hidden>
                {Array.from({ length: 12 }, (_, i) => (
                  <div key={i} className={cn('grid h-9 items-center border-b border-line/60', GRID_COLS)}>
                    <div className="px-2">
                      <div className="mx-auto size-[15px] animate-shimmer rounded bg-hover" />
                    </div>
                    <div className="px-2">
                      <div className="h-3.5 w-20 animate-shimmer rounded bg-hover" />
                    </div>
                    <div className="px-2">
                      <div className="h-3.5 w-3/5 animate-shimmer rounded bg-hover" />
                    </div>
                  </div>
                ))}
              </div>
            ) : body ? (
              <div className="py-6">{body}</div>
            ) : (
              <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
                {vItems.map((v) => {
                  const item = pages.getItem(v.index)
                  return (
                    <ImageRow
                      key={v.key}
                      projectId={projectId}
                      index={v.index}
                      item={item}
                      classesById={classesById}
                      selected={!!item && (selection.all || selection.ids.has(item.id))}
                      focused={v.index === focusIndex}
                      style={{ height: ROW_HEIGHT, transform: `translateY(${v.start - HEADER_HEIGHT}px)` }}
                      onToggle={toggleRow}
                      onOpen={openImage}
                      onKeyDown={onRowKeyDown}
                      onFocusRow={setFocusIndex}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </ErrorBoundary>

      {distributing && (
        <DistributeDialog
          open
          onOpenChange={setDistributing}
          members={project.members}
          count={targetCount}
          scopeLabel={
            selectedCount > 0
              ? `the ${pluralize(targetCount, 'selected image')}`
              : filtered
                ? `the ${pluralize(targetCount, 'image')} matching the filters`
                : `all ${pluralize(targetCount, 'image')}`
          }
          target={target}
          pending={bulk.isPending}
          onSubmit={(b) =>
            bulk.mutate(
              { body: b, label: 'Images distributed' },
              { onSuccess: () => setDistributing(false) },
            )
          }
        />
      )}
    </div>
  )
}
