import { useLayoutEffect, useRef } from 'react'
import { ChevronDown, Copy, Lock, LockOpen, Trash2 } from 'lucide-react'
import type { ScreenRect } from '@/canvas'
import { UNKNOWN_CLASS_COLOR } from '@/lib/colors'
import { useBindings } from '@/hooks/useBindings'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'
import { useAnnotator } from './store'
import { useWorkspace } from './workspaceContext'

const GAP = 8

function unionRect(rects: ScreenRect[]): ScreenRect | null {
  if (rects.length === 0) return null
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const r of rects) {
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.w)
    y2 = Math.max(y2, r.y + r.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** Class / duplicate / lock / delete for the selection, positioned from boxScreenRect (follows pan & zoom). */
export function FloatingBoxToolbar({ containerWidth, containerHeight }: { containerWidth: number; containerHeight: number }) {
  const ws = useWorkspace()
  const bindings = useBindings()
  const selectedIds = useAnnotator((s) => s.selectedIds)
  const view = useAnnotator((s) => s.view)
  const gesture = useAnnotator((s) => s.gesture)
  const picker = useAnnotator((s) => s.picker)
  const preview = useAnnotator((s) => s.preview)
  const openPicker = useAnnotator((s) => s.openPicker)
  const ref = useRef<HTMLDivElement>(null)

  const selected = ws.doc.boxes.filter((b) => selectedIds.includes(b.id) && !b.hidden)
  const ids = selected.map((b) => b.id)
  const hidden = !ws.editable || gesture || !!picker || !!preview || selected.length === 0

  useLayoutEffect(() => {
    if (hidden) return
    const canvas = ws.canvasRef.current
    const rect = unionRect(ids.map((id) => canvas?.boxScreenRect(id)).filter((r): r is ScreenRect => !!r))
    const el = ref.current
    if (!el) return
    if (!rect) {
      el.style.visibility = 'hidden'
      return
    }
    const tw = el.offsetWidth
    const th = el.offsetHeight
    let left = rect.x + rect.w / 2 - tw / 2
    let top = rect.y + rect.h + GAP
    if (top + th > containerHeight - 56) top = rect.y - th - GAP // above the box when no room below
    left = Math.min(Math.max(left, 8), Math.max(containerWidth - tw - 8, 8))
    top = Math.min(Math.max(top, 8), Math.max(containerHeight - th - 8, 8))
    // Positioned imperatively: it follows every pan/zoom frame without re-rendering React.
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.visibility = 'visible'
    // ids.join keeps the dependency stable across renders with the same selection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, ids.join(','), view, ws.doc.boxes, containerWidth, containerHeight, ws.canvasRef])

  if (hidden) return null
  const first = selected[0]!
  const sameClass = selected.every((b) => b.classId === first.classId)
  const cls = sameClass && first.classId !== null ? ws.classById.get(first.classId) : undefined
  const label = !sameClass ? `${selected.length} boxes` : cls ? cls.name : (first.rawLabel ?? 'Unknown')
  const allLocked = selected.every((b) => b.locked)

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Selected box actions"
      className="absolute z-20 flex h-[30px] items-center gap-0.5 rounded-lg border border-line bg-elevated/95 px-[3px] shadow-pop backdrop-blur-sm"
      style={{ left: 0, top: 0, visibility: 'hidden' }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Tooltip content="Change class" shortcut={bindings['class.pick']}>
        <button
          type="button"
          className="flex h-[22px] max-w-40 items-center gap-1.5 rounded-[5px] bg-hover px-2 text-sm text-fg hover:brightness-110"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            openPicker({ mode: 'assign', ids, anchor: { x: r.right, y: r.top } })
          }}
        >
          <span
            className="size-2.5 shrink-0 rounded-[3px]"
            style={{ background: cls?.color ?? UNKNOWN_CLASS_COLOR }}
            aria-hidden
          />
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3 shrink-0 text-muted" aria-hidden />
        </button>
      </Tooltip>
      <IconButton
        size="sm"
        label="Duplicate"
        shortcut={bindings['box.duplicate']}
        icon={<Copy />}
        onClick={() => ws.actions.duplicate(ids)}
      />
      <IconButton
        size="sm"
        label={allLocked ? 'Unlock' : 'Lock (prevent moving)'}
        icon={allLocked ? <LockOpen /> : <Lock />}
        active={allLocked}
        onClick={() => ws.actions.toggleLocked(ids)}
      />
      <IconButton
        size="sm"
        variant="danger"
        label="Delete"
        shortcut={bindings['box.delete']}
        icon={<Trash2 />}
        onClick={() => ws.actions.remove(ids)}
      />
    </div>
  )
}
