import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react'
import { Flag, MessageCircle } from 'lucide-react'
import type { ImageItem, ProjectClass } from '@/lib/types'
import { STATUS_META } from '@/lib/status'
import { thumbUrl } from '@/lib/endpoints'
import { formatDateTime, formatNumber, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/Avatar'
import { Checkbox } from '@/components/ui/Checkbox'
import { Skeleton } from '@/components/ui/Feedback'
import { Tooltip } from '@/components/ui/Tooltip'
import { StatusIcon } from '@/components/StatusIcon'
import { GRID_COLS } from './imagesTableUtils'

interface ImageRowProps {
  projectId: number
  index: number
  item: ImageItem | undefined
  classesById: ReadonlyMap<number, ProjectClass>
  selected: boolean
  focused: boolean
  style: CSSProperties
  onToggle: (index: number, item: ImageItem, shift: boolean) => void
  onOpen: (item: ImageItem) => void
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>, index: number, item: ImageItem | undefined) => void
  onFocusRow: (index: number) => void
}

const cell = 'flex min-w-0 items-center px-2'

export function ImageRow({
  projectId,
  index,
  item,
  classesById,
  selected,
  focused,
  style,
  onToggle,
  onOpen,
  onKeyDown,
  onFocusRow,
}: ImageRowProps) {
  if (!item) {
    return (
      <div style={style} className={cn('absolute inset-x-0 grid items-center border-b border-line/60', GRID_COLS)} aria-hidden>
        <div className={cell}>
          <Skeleton className="size-[15px]" />
        </div>
        <div className={cell}>
          <Skeleton className="h-3.5 w-20" />
        </div>
        <div className={cell}>
          <Skeleton className="h-3.5 w-3/5" />
        </div>
      </div>
    )
  }

  const classes = item.class_ids.map((id) => classesById.get(id)).filter((c): c is ProjectClass => !!c)
  const label = `${item.rel_path}, ${STATUS_META[item.status].label}, ${item.box_count} boxes`

  return (
    <div
      role="row"
      aria-rowindex={index + 2}
      aria-selected={selected}
      aria-label={label}
      data-row-index={index}
      tabIndex={focused ? 0 : -1}
      style={style}
      onFocus={() => onFocusRow(index)}
      onClick={(e: MouseEvent) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) onToggle(index, item, e.shiftKey)
        else onOpen(item)
      }}
      onKeyDown={(e) => onKeyDown(e, index, item)}
      className={cn(
        'absolute inset-x-0 grid cursor-pointer items-center border-b border-line/60 text-sm outline-none transition-colors',
        GRID_COLS,
        selected ? 'bg-accent-soft' : 'hover:bg-hover/70',
        'focus-visible:shadow-[inset_2px_0_0_var(--accent)] focus-visible:bg-hover',
      )}
    >
      <div role="gridcell" className={cn(cell, 'justify-center')}>
        <Checkbox
          checked={selected}
          aria-label={`Select ${item.filename}`}
          tabIndex={-1}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onToggle(index, item, e.shiftKey)
          }}
        />
      </div>
      <div role="gridcell" className={cn(cell, 'gap-1.5')}>
        <StatusIcon status={item.status} boxCount={item.box_count} />
        <span className="truncate text-muted">{STATUS_META[item.status].label}</span>
      </div>
      <div role="gridcell" className={cell}>
        <Tooltip
          side="right"
          align="start"
          delayDuration={600}
          content={
            <img
              src={thumbUrl(projectId, item.id, 256)}
              alt=""
              loading="lazy"
              className="max-h-48 max-w-60 rounded bg-canvas object-contain"
            />
          }
        >
          <span className="truncate font-mono text-xs text-fg" title={item.rel_path}>
            {item.rel_path}
          </span>
        </Tooltip>
      </div>
      <div role="gridcell" className={cn(cell, 'justify-end tabular-nums', item.box_count ? 'text-fg' : 'text-dim')}>
        {formatNumber(item.box_count)}
      </div>
      <div role="gridcell" className={cn(cell, 'gap-1')}>
        {classes.length > 0 && (
          <Tooltip content={classes.map((c) => c.name).join(', ')}>
            <span className="flex items-center gap-1">
              {classes.slice(0, 5).map((c) => (
                <span key={c.id} className="size-2.5 rounded-sm" style={{ background: c.color }} aria-hidden />
              ))}
              {classes.length > 5 && <span className="text-xs text-dim">+{classes.length - 5}</span>}
            </span>
          </Tooltip>
        )}
      </div>
      <div role="gridcell" className={cn(cell, 'gap-1.5')}>
        {item.assignee ? (
          <>
            <Avatar user={item.assignee} size="xs" tooltip={false} />
            <span className="truncate text-fg">{item.assignee.display_name}</span>
          </>
        ) : (
          <span className="text-dim">Unassigned</span>
        )}
      </div>
      <div role="gridcell" className={cn(cell, 'justify-center')}>
        {item.flagged && <Flag className="size-3.5 text-warn" aria-label="Flagged" />}
      </div>
      <div role="gridcell" className={cn(cell, 'gap-1 tabular-nums')}>
        {item.open_comment_count > 0 ? (
          <span className="flex items-center gap-1 text-warn" title={`${item.open_comment_count} open of ${item.comment_count}`}>
            <MessageCircle className="size-3.5" aria-hidden />
            {item.open_comment_count}
          </span>
        ) : item.comment_count > 0 ? (
          <span className="flex items-center gap-1 text-dim" title={`${item.comment_count} resolved`}>
            <MessageCircle className="size-3.5" aria-hidden />
            {item.comment_count}
          </span>
        ) : null}
      </div>
      <div role="gridcell" className={cn(cell, 'gap-1.5')}>
        {item.last_editor ? (
          <>
            <Avatar user={item.last_editor} size="xs" tooltip={false} />
            <span className="truncate text-muted">{item.last_editor.display_name}</span>
          </>
        ) : (
          <span className="text-dim">—</span>
        )}
      </div>
      <div role="gridcell" className={cn(cell, 'text-xs text-muted')}>
        {item.updated_at ? (
          <time dateTime={item.updated_at} title={formatDateTime(item.updated_at)} className="truncate">
            {relativeTime(item.updated_at)}
          </time>
        ) : (
          <span className="text-dim">—</span>
        )}
      </div>
    </div>
  )
}
