import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useSearchParams } from 'react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ArrowUpDown, Flag, MessageSquare, PanelLeftClose, Search, X } from 'lucide-react'
import { filtersToParams, hasActiveFilters, type ImageFilters } from '@/lib/filters'
import { formatNumber, formatPercent } from '@/lib/format'
import type { ImageItem, ImageStatus, Project, UserBrief } from '@/lib/types'
import { STATUS_META } from '@/lib/status'
import { cn } from '@/lib/utils'
import { useImagePages } from '@/hooks/useImagePages'
import { useRealtime } from '@/stores/realtime'
import { useSession } from '@/stores/session'
import { useUi } from '@/stores/ui'
import { Avatar, AvatarStack } from '@/components/ui/Avatar'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { ErrorState, Skeleton } from '@/components/ui/Feedback'
import { StatusIcon } from '@/components/StatusIcon'

const ROW_HEIGHT = 30

interface FilesPanelProps {
  project: Project
  imageId: number
  filters: ImageFilters
  /** Index of the current image within the filter (-1 when excluded). */
  currentIndex: number
  onOpen: (imageId: number) => void
}

type ChipId = 'all' | 'mine' | ImageStatus | 'flagged' | 'comments'

const STATUS_CHIPS: ImageStatus[] = ['todo', 'in_progress', 'review', 'rejected', 'done']

function Row({
  item,
  current,
  active,
  here,
  onOpen,
  id,
}: {
  item: ImageItem | undefined
  current: boolean
  active: boolean
  here: UserBrief[] | undefined
  onOpen: (id: number) => void
  id: string
}) {
  if (!item) {
    return (
      <div className="flex h-full items-center gap-2 px-2">
        <Skeleton className="size-3.5 rounded-full" />
        <Skeleton className="h-3 flex-1" />
      </div>
    )
  }
  return (
    <div
      id={id}
      role="option"
      aria-selected={current}
      onClick={() => onOpen(item.id)}
      className={cn(
        'flex h-full cursor-pointer items-center gap-2 rounded-md px-2 text-fg/85 transition-colors',
        current ? 'bg-accent-soft text-fg shadow-[inset_2px_0_0_var(--accent)]' : 'hover:bg-hover',
        active && !current && 'bg-hover ring-1 ring-inset ring-line-strong',
      )}
    >
      <StatusIcon status={item.status} boxCount={item.box_count} />
      <span className="min-w-0 flex-1 truncate font-mono text-xs" title={item.rel_path}>
        {item.filename}
      </span>
      {item.flagged && <Flag className="size-3 shrink-0 text-warn" aria-label="Flagged" />}
      {item.open_comment_count > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 text-2xs text-warn" aria-label={`${item.open_comment_count} open comments`}>
          <MessageSquare className="size-3" aria-hidden />
          {item.open_comment_count}
        </span>
      )}
      {here && here.length > 0 && <AvatarStack users={here} size="xs" max={2} />}
      {item.assignee && !here?.some((u) => u.id === item.assignee?.id) && (
        <Avatar user={item.assignee} size="xs" tooltip={`Assigned to ${item.assignee.display_name}`} />
      )}
      <span className={cn('min-w-3 text-right text-2xs tabular', current ? 'text-accent-text' : 'text-dim')}>
        {item.box_count || ''}
      </span>
    </div>
  )
}

/** Virtualised file list (100k+ rows, pages of 200), server-side search, filter chips and sort. */
export function FilesPanel({ project, imageId, filters, currentIndex, onOpen }: FilesPanelProps) {
  const [params, setParams] = useSearchParams()
  const meId = useSession((s) => s.user?.id)
  const setFilesPanelOpen = useUi((s) => s.setFilesPanelOpen)
  const presence = useRealtime((s) => (s.presenceProjectId === project.id ? s.presence : null))
  const pages = useImagePages(project.id, filters)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState(filters.q ?? '')
  const [activeIndex, setActiveIndex] = useState(-1)
  const total = pages.total ?? 0

  const update = (next: ImageFilters) => setParams(filtersToParams(next, params), { replace: true })

  // Debounced server-side search.
  useEffect(() => {
    if ((filters.q ?? '') === search) return
    const t = setTimeout(() => setParams(filtersToParams({ ...filters, q: search || undefined }, params), { replace: true }), 250)
    return () => clearTimeout(t)
  }, [search, filters, params, setParams])

  const presenceByImage = useMemo(() => {
    const map = new Map<number, UserBrief[]>()
    for (const p of Object.values(presence ?? {})) {
      if (p.user.id === meId || p.imageId === null) continue
      const list = map.get(p.imageId)
      if (list) list.push(p.user)
      else map.set(p.imageId, [p.user])
    }
    return map
  }, [presence, meId])

  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualiser re-renders through its own state
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })
  const items = virtualizer.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items[items.length - 1]?.index ?? 0
  const { setVisibleRange } = pages
  useEffect(() => setVisibleRange(first, last), [first, last, setVisibleRange])

  // Keep the current image in view.
  useEffect(() => {
    if (currentIndex >= 0 && currentIndex < total) virtualizer.scrollToIndex(currentIndex, { align: 'auto' })
  }, [currentIndex, total, virtualizer])

  const chipOn = (c: ChipId): boolean => {
    switch (c) {
      case 'all':
        return !hasActiveFilters({ ...filters, q: undefined })
      case 'mine':
        return filters.assignee === 'me'
      case 'flagged':
        return filters.flagged === true
      case 'comments':
        return filters.has_comments === 'open'
      default:
        return !!filters.status?.includes(c)
    }
  }

  const toggleChip = (c: ChipId) => {
    switch (c) {
      case 'all':
        return update({ q: filters.q, sort: filters.sort })
      case 'mine':
        return update({ ...filters, assignee: filters.assignee === 'me' ? undefined : 'me' })
      case 'flagged':
        return update({ ...filters, flagged: filters.flagged ? undefined : true })
      case 'comments':
        return update({ ...filters, has_comments: filters.has_comments === 'open' ? undefined : 'open' })
      default: {
        const cur = filters.status ?? []
        const next = cur.includes(c) ? cur.filter((s) => s !== c) : [...cur, c]
        return update({ ...filters, status: next.length ? next : undefined })
      }
    }
  }

  const chip = (c: ChipId, label: React.ReactNode, count?: number, title?: string) => (
    <button
      key={c}
      type="button"
      aria-pressed={chipOn(c)}
      title={title}
      onClick={() => toggleChip(c)}
      className={cn(
        'inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 text-xs transition-colors',
        chipOn(c)
          ? 'border-accent/45 bg-accent-soft text-fg'
          : 'border-line bg-panel-2 text-muted hover:border-line-strong hover:text-fg',
      )}
    >
      {label}
      {count !== undefined && <em className="not-italic text-2xs text-dim">{formatCompact(count)}</em>}
    </button>
  )

  function onListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (total === 0) return
    let next = activeIndex < 0 ? Math.max(currentIndex, 0) : activeIndex
    if (e.key === 'ArrowDown') next = Math.min(next + 1, total - 1)
    else if (e.key === 'ArrowUp') next = Math.max(next - 1, 0)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = total - 1
    else if (e.key === 'PageDown') next = Math.min(next + 15, total - 1)
    else if (e.key === 'PageUp') next = Math.max(next - 15, 0)
    else if (e.key === 'Enter') {
      const item = pages.getItem(next)
      if (item) onOpen(item.id)
      e.preventDefault()
      return
    } else return
    e.preventDefault()
    e.stopPropagation()
    setActiveIndex(next)
    virtualizer.scrollToIndex(next, { align: 'auto' })
  }

  const done = project.status_counts.done
  const activeItem = activeIndex >= 0 ? pages.getItem(activeIndex) : undefined

  return (
    <aside aria-label="Files" className="flex h-full min-h-0 flex-col bg-panel">
      <div className="flex h-9 shrink-0 items-center gap-2 pl-3 pr-1.5">
        <h2 className="text-2xs font-bold uppercase tracking-[0.08em] text-muted">Files</h2>
        <span className="text-xs text-dim tabular">{pages.total !== undefined ? formatNumber(total) : ''}</span>
        <span className="flex-1" />
        <IconButton size="sm" label="Hide files panel" icon={<PanelLeftClose />} onClick={() => setFilesPanelOpen(false)} />
      </div>
      <div className="px-2.5">
        <Input
          size="sm"
          leftIcon={<Search />}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && search) {
              e.stopPropagation()
              setSearch('')
            }
          }}
          placeholder={`Search ${formatNumber(project.image_count)} files`}
          aria-label="Search files"
          rightSlot={
            search ? (
              <IconButton size="xs" label="Clear search" icon={<X />} onClick={() => setSearch('')} noTooltip />
            ) : undefined
          }
        />
      </div>
      <div className="flex flex-wrap gap-1 px-2.5 pb-1.5 pt-2" role="group" aria-label="Filters">
        {chip('all', 'All')}
        {chip('mine', 'Mine', undefined, 'Assigned to me')}
        {STATUS_CHIPS.map((s) => chip(s, STATUS_META[s].label, project.status_counts[s]))}
      </div>
      <div className="flex items-center gap-1.5 pb-1.5 pl-3 pr-2.5 text-xs text-muted">
        <ArrowUpDown className="size-3" aria-hidden />
        <Select
          size="sm"
          aria-label="Sort files"
          className="h-6 w-auto border-transparent bg-transparent px-1 hover:border-line"
          value={filters.sort ?? 'name'}
          onValueChange={(v) => update({ ...filters, sort: v === 'name' ? undefined : v })}
          items={[
            { value: 'name', label: 'Name (natural)' },
            { value: 'updated', label: 'Recently updated' },
          ]}
        />
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="More filters">
          {chip('flagged', <Flag className="size-3 text-warn" aria-hidden />, undefined, 'Flagged')}
          {chip('comments', <MessageSquare className="size-3" aria-hidden />, undefined, 'Has open comments')}
        </div>
      </div>
      <div
        ref={scrollRef}
        role="listbox"
        aria-label="Images"
        tabIndex={0}
        aria-activedescendant={activeItem ? `file-${activeItem.id}` : undefined}
        onKeyDown={onListKeyDown}
        className="relative min-h-0 flex-1 overflow-y-auto px-1.5 focus-visible:outline-offset-[-2px]"
      >
        {pages.isPending ? (
          <div className="flex flex-col gap-1 p-1">
            {Array.from({ length: 12 }, (_, i) => (
              <Skeleton key={i} className="h-6" />
            ))}
          </div>
        ) : pages.error ? (
          <ErrorState compact error={pages.error} onRetry={pages.refetch} />
        ) : total === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted">
            {hasActiveFilters(filters) ? 'No images match these filters.' : 'No images in this project yet.'}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {items.map((v) => {
              const item = pages.getItem(v.index)
              return (
                <div
                  key={v.key}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${v.start}px)` }}
                >
                  <Row
                    id={item ? `file-${item.id}` : `file-row-${v.index}`}
                    item={item}
                    current={item?.id === imageId}
                    active={v.index === activeIndex}
                    here={item ? presenceByImage.get(item.id) : undefined}
                    onOpen={(id) => {
                      setActiveIndex(v.index)
                      onOpen(id)
                    }}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-line px-3 pb-3 pt-2.5 text-xs">
        <div className="flex justify-between">
          <span className="text-muted">{formatNumber(done)} done</span>
          <span className="text-fg tabular">{formatPercent(done, project.image_count, 1)}</span>
        </div>
        <div
          className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-hover"
          role="progressbar"
          aria-label="Project progress"
          aria-valuenow={Math.round((done / Math.max(project.image_count, 1)) * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-[#2b6ca3] to-[#3d8fd6] transition-[width] duration-500"
            style={{ width: formatPercent(done, project.image_count, 2) }}
          />
        </div>
      </div>
    </aside>
  )
}

function formatCompact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n)
}
