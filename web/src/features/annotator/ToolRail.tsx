import { Crosshair, Hand, Maximize, MapPin, MousePointer2, Redo2, SquareDashed, Type, Undo2 } from 'lucide-react'
import type { CanvasTool } from '@/canvas'
import { useBindings } from '@/hooks/useBindings'
import { useSettings } from '@/stores/settings'
import { IconButton } from '@/components/ui/IconButton'
import { useAnnotator } from './store'
import { useWorkspace } from './workspaceContext'

/** Vertical tool rail: tools, view toggles, undo/redo. */
export function ToolRail() {
  const ws = useWorkspace()
  const bindings = useBindings()
  const tool = useAnnotator((s) => s.tool)
  const spacePan = useAnnotator((s) => s.spacePan)
  const setTool = useAnnotator((s) => s.setTool)
  const showPins = useAnnotator((s) => s.showPins)
  const setShowPins = useAnnotator((s) => s.setShowPins)
  const showLabels = useSettings((s) => s.settings.show_labels)
  const showCrosshair = useSettings((s) => s.settings.show_crosshair)
  const update = useSettings((s) => s.update)
  const current: CanvasTool = spacePan ? 'pan' : tool

  const toolButton = (t: CanvasTool, label: string, icon: React.ReactNode, action: 'tool.select' | 'tool.box' | 'tool.pan') => (
    <IconButton
      label={label}
      icon={icon}
      shortcut={bindings[action]}
      tooltipSide="right"
      size="lg"
      variant={current === t ? 'solid' : 'ghost'}
      aria-pressed={current === t}
      disabled={t === 'box' && !ws.editable}
      onClick={() => setTool(t)}
    />
  )

  return (
    <nav
      aria-label="Tools"
      className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2"
    >
      {toolButton('select', 'Select', <MousePointer2 />, 'tool.select')}
      {toolButton('box', 'Draw box', <SquareDashed />, 'tool.box')}
      {toolButton('pan', 'Pan (hold Space)', <Hand />, 'tool.pan')}
      <div className="my-1 h-px w-[22px] bg-line" aria-hidden />
      <IconButton
        label="Zoom to fit"
        icon={<Maximize />}
        shortcut={bindings['view.fit']}
        tooltipSide="right"
        size="lg"
        onClick={() => ws.canvasRef.current?.zoomToFit()}
      />
      <IconButton
        label={showLabels ? 'Hide labels' : 'Show labels'}
        icon={<Type />}
        shortcut={bindings['view.labels']}
        tooltipSide="right"
        size="lg"
        active={showLabels}
        onClick={() => update({ show_labels: !showLabels })}
      />
      <IconButton
        label={showCrosshair ? 'Hide crosshair' : 'Show crosshair'}
        icon={<Crosshair />}
        shortcut={bindings['view.crosshair']}
        tooltipSide="right"
        size="lg"
        active={showCrosshair}
        onClick={() => update({ show_crosshair: !showCrosshair })}
      />
      <IconButton
        label={showPins ? 'Hide comment pins' : 'Show comment pins'}
        icon={<MapPin />}
        tooltipSide="right"
        size="lg"
        active={showPins}
        onClick={() => setShowPins(!showPins)}
      />
      <div className="flex-1" />
      <IconButton
        label="Undo"
        icon={<Undo2 />}
        shortcut={bindings.undo}
        tooltipSide="right"
        size="lg"
        disabled={!ws.editable || !ws.doc.canUndo}
        onClick={ws.doc.undo}
      />
      <IconButton
        label="Redo"
        icon={<Redo2 />}
        shortcut={bindings.redo}
        tooltipSide="right"
        size="lg"
        disabled={!ws.editable || !ws.doc.canRedo}
        onClick={ws.doc.redo}
      />
    </nav>
  )
}
