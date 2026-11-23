import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronRight, CornerLeftUp, Folder, FolderOpen, HardDrive, Images } from 'lucide-react'
import { browseFs, getFsRoots } from '@/lib/endpoints'
import { qk } from '@/lib/queryKeys'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/ui/Feedback'
import { Tooltip } from '@/components/ui/Tooltip'

interface FolderBrowserProps {
  /** Currently chosen folder (highlighted when browsing it). */
  selected: string | null
  onSelect: (path: string, imageCount: number) => void
  selectLabel?: string
  /** Start inside this folder instead of the roots list. */
  initialPath?: string | null
  className?: string
}

const rowClass =
  'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-base text-fg transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60'

/** Server-side folder picker (admin only), limited to the configured roots. */
export function FolderBrowser({ selected, onSelect, selectLabel = 'Use this folder', initialPath = null, className }: FolderBrowserProps) {
  const [path, setPath] = useState<string | null>(initialPath)
  const roots = useQuery({ queryKey: qk.fsRoots, queryFn: ({ signal }) => getFsRoots({ signal }), staleTime: 60_000 })
  const browse = useQuery({
    queryKey: qk.fsBrowse(path ?? ''),
    queryFn: ({ signal }) => browseFs(path!, { signal }),
    enabled: path !== null,
    staleTime: 30_000,
  })
  const current = path !== null ? browse.data : undefined
  const isSelected = !!current && current.path === selected

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-folder-row]'))
    const i = rows.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = e.key === 'ArrowDown' ? Math.min(i + 1, rows.length - 1) : Math.max(i - 1, 0)
      rows[i < 0 ? 0 : next]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      rows[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      rows[rows.length - 1]?.focus()
    } else if (e.key === 'Backspace' && path !== null) {
      e.preventDefault()
      setPath(current?.parent ?? null)
    }
  }

  let list: ReactNode
  if (path === null) {
    if (roots.isPending) list = <SkeletonRows rows={4} className="p-2" rowClassName="h-8" />
    else if (roots.isError) list = <ErrorState compact error={roots.error} onRetry={() => void roots.refetch()} />
    else if (roots.data.length === 0)
      list = (
        <EmptyState
          compact
          icon={<HardDrive />}
          title="No folders are shared"
          description="Start the server with --root PATH to make dataset folders available."
        />
      )
    else
      list = roots.data.map((r) => (
        <button key={r.path} type="button" data-folder-row className={rowClass} onClick={() => setPath(r.path)}>
          <HardDrive className="size-4 shrink-0 text-muted" aria-hidden />
          <span className="font-medium">{r.name}</span>
          <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-dim">{r.path}</span>
          <ChevronRight className="size-3.5 shrink-0 text-dim" aria-hidden />
        </button>
      ))
  } else if (browse.isPending) {
    list = <SkeletonRows rows={6} className="p-2" rowClassName="h-8" />
  } else if (browse.isError) {
    list = <ErrorState compact title="Could not open this folder" error={browse.error} onRetry={() => void browse.refetch()} />
  } else if (browse.data.entries.length === 0) {
    list = <EmptyState compact icon={<FolderOpen />} title="No sub-folders" description="You can use this folder as it is." />
  } else {
    list = browse.data.entries.map((e) => (
      <button key={e.path} type="button" data-folder-row className={rowClass} onClick={() => setPath(e.path)}>
        <Folder className={cn('size-4 shrink-0', e.path === selected ? 'text-accent-text' : 'text-muted')} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{e.name}</span>
        {e.image_count !== null && e.image_count > 0 && (
          <span className="shrink-0 text-xs tabular-nums text-muted">{formatNumber(e.image_count)} images</span>
        )}
        <ChevronRight className="size-3.5 shrink-0 text-dim" aria-hidden />
      </button>
    ))
  }

  return (
    <div className={cn('flex flex-col overflow-hidden rounded-lg border border-line bg-panel-2', className)}>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-1.5">
        <IconButton size="sm" label="All roots" icon={<HardDrive />} onClick={() => setPath(null)} disabled={path === null} />
        <IconButton
          size="sm"
          label="Parent folder"
          shortcut="Backspace"
          icon={<CornerLeftUp />}
          onClick={() => setPath(current?.parent ?? null)}
          disabled={path === null}
        />
        <Tooltip content={path ?? 'Shared roots'} disabled={path === null}>
          <div
            className="min-w-0 flex-1 truncate px-1.5 font-mono text-xs text-muted [direction:rtl] [text-align:left]"
            aria-live="polite"
          >
            <bdi>{path ?? 'Shared roots'}</bdi>
          </div>
        </Tooltip>
      </div>
      <div
        className="h-64 overflow-y-auto p-1"
        role="group"
        aria-label={path === null ? 'Shared roots' : `Sub-folders of ${path}`}
        onKeyDown={onKeyDown}
      >
        {list}
      </div>
      <div className="flex h-12 shrink-0 items-center gap-3 border-t border-line px-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-muted">
          {current ? (
            <>
              <Images className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">
                <span className="font-medium text-fg tabular-nums">{formatNumber(current.image_count)}</span>{' '}
                {current.image_count === 1 ? 'image' : 'images'} in this folder
              </span>
            </>
          ) : (
            <span>Choose a root, then open folders.</span>
          )}
        </div>
        {isSelected ? (
          <span className="flex items-center gap-1 text-sm font-medium text-ok">
            <Check className="size-4" aria-hidden />
            Selected
          </span>
        ) : (
          <Button size="sm" variant="primary" disabled={!current} onClick={() => current && onSelect(current.path, current.image_count)}>
            {selectLabel}
          </Button>
        )}
      </div>
    </div>
  )
}
