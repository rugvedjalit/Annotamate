import { Minus, Plus } from 'lucide-react'
import { useBindings } from '@/hooks/useBindings'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'
import { useAnnotator } from './store'
import { useWorkspace } from './workspaceContext'

/** Floating −, %, +, Fit, 1:1 control at the bottom of the canvas. */
export function ZoomControl() {
  const ws = useWorkspace()
  const bindings = useBindings()
  const scale = useAnnotator((s) => s.view?.scale ?? 1)
  const canvas = () => ws.canvasRef.current
  return (
    <div
      role="toolbar"
      aria-label="Zoom"
      className="absolute bottom-3.5 left-1/2 z-10 flex h-8 -translate-x-1/2 items-center gap-0.5 rounded-[9px] border border-line bg-panel/95 px-1 shadow-pop backdrop-blur-sm"
    >
      <IconButton size="sm" label="Zoom out" icon={<Minus />} onClick={() => canvas()?.zoomBy(1 / 1.25)} />
      <span className="w-12 text-center font-mono text-xs text-fg tabular" aria-live="polite" aria-label={`Zoom ${Math.round(scale * 100)} percent`}>
        {Math.round(scale * 100)}%
      </span>
      <IconButton size="sm" label="Zoom in" icon={<Plus />} onClick={() => canvas()?.zoomBy(1.25)} />
      <span className="mx-1 h-4 w-px bg-line" aria-hidden />
      <Tooltip content="Zoom to fit" shortcut={bindings['view.fit']}>
        <button
          type="button"
          onClick={() => canvas()?.zoomToFit()}
          className="grid h-6 place-items-center rounded-md px-2 text-xs font-medium text-muted hover:bg-hover hover:text-fg"
        >
          Fit
        </button>
      </Tooltip>
      <Tooltip content="Actual size (1 image px = 1 screen px)" shortcut={bindings['view.actual']}>
        <button
          type="button"
          onClick={() => canvas()?.zoomToActual()}
          className="grid h-6 place-items-center rounded-md px-2 text-xs font-medium text-muted hover:bg-hover hover:text-fg"
        >
          1:1
        </button>
      </Tooltip>
    </div>
  )
}
