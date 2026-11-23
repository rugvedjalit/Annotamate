import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn, clamp } from '@/lib/utils'

interface ResizeHandleProps {
  /** Which edge of the panel the handle sits on. */
  edge: 'left' | 'right'
  width: number
  min: number
  max: number
  /** Called continuously while dragging. */
  onResize: (width: number) => void
  /** Called once when the drag ends (persist here). */
  onCommit: (width: number) => void
  label: string
}

/** Draggable + keyboard-operable panel splitter (role="separator"). */
export function ResizeHandle({ edge, width, min, max, onResize, onCommit, label }: ResizeHandleProps) {
  const start = useRef<{ x: number; w: number } | null>(null)
  const [dragging, setDragging] = useState(false)

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, w: width }
    setDragging(true)
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    if (!start.current) return
    const dx = e.clientX - start.current.x
    onResize(clamp(Math.round(start.current.w + (edge === 'right' ? dx : -dx)), min, max))
  }

  function end(e: PointerEvent<HTMLDivElement>) {
    if (!start.current) return
    const dx = e.clientX - start.current.x
    const w = clamp(Math.round(start.current.w + (edge === 'right' ? dx : -dx)), min, max)
    start.current = null
    setDragging(false)
    onCommit(w)
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 40 : 10
    let w: number | null = null
    if (e.key === 'ArrowLeft') w = width + (edge === 'right' ? -step : step)
    else if (e.key === 'ArrowRight') w = width + (edge === 'right' ? step : -step)
    else if (e.key === 'Home') w = min
    else if (e.key === 'End') w = max
    if (w === null) return
    e.preventDefault()
    e.stopPropagation()
    const next = clamp(w, min, max)
    onResize(next)
    onCommit(next)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      className={cn(
        'group absolute inset-y-0 z-10 w-1.5 cursor-col-resize touch-none focus-visible:outline-none',
        edge === 'right' ? '-right-[3px]' : '-left-[3px]',
      )}
    >
      <span
        className={cn(
          'absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors group-hover:bg-accent/60 group-focus-visible:bg-accent',
          dragging && 'bg-accent',
        )}
      />
    </div>
  )
}
