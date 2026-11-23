// All annotator shortcuts (rebindable via the keymap) plus fixed keys: arrows nudge the selection
// (Shift = 10 px) or navigate images when nothing is selected, and Space held = temporary pan.
import { useEffect, useRef } from 'react'
import { isEditableTarget } from '@/lib/keymap'
import { useShortcuts } from '@/hooks/useShortcuts'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { useSession } from '@/stores/session'
import { reviewActions } from './reviewActions'
import { useAnnotator } from './store'
import type { Workspace } from './workspaceContext'

const ARROW_RE = /^(Shift\+)?Arrow(Left|Right|Up|Down)$/

/** Viewport point at the top-right of the selection (picker anchor). */
function selectionAnchor(ws: Workspace, ids: string[]): { x: number; y: number } {
  const canvas = ws.canvasRef.current
  const container = document.querySelector('[data-annotator-canvas]')?.getBoundingClientRect()
  let best: { x: number; y: number } | null = null
  for (const id of ids) {
    const r = canvas?.boxScreenRect(id)
    if (r && (!best || r.y < best.y)) best = { x: r.x + r.w, y: r.y }
  }
  const ox = container?.left ?? 0
  const oy = container?.top ?? 0
  return best ? { x: ox + best.x, y: oy + best.y } : { x: ox + 80, y: oy + 80 }
}

/** Tab cycles boxes only while focus is on the page/canvas, so keyboard users can still tab through the UI. */
function focusIsOnCanvasOrBody(): boolean {
  const a = document.activeElement
  return !a || a === document.body || !!a.closest('[data-annotator-canvas]')
}

export function useAnnotatorKeys(ws: Workspace): void {
  const ref = useRef<Workspace | null>(ws)
  useEffect(() => {
    ref.current = ws
  })

  const st = () => useAnnotator.getState()
  const sel = () => {
    const w = ref.current
    if (!w) return []
    const ids = new Set(w.doc.boxes.map((b) => b.id))
    return st().selectedIds.filter((id) => ids.has(id))
  }
  const toggleSetting = (key: 'show_labels' | 'show_crosshair') => {
    const s = useSettings.getState()
    s.update({ [key]: !s.settings[key] })
  }

  useShortcuts(
    'annotator',
    {
      'tool.select': () => st().setTool('select'),
      'tool.box': () => {
        if (!ref.current?.editable) return false
        st().setTool('box')
      },
      'tool.pan': () => st().setTool('pan'),
      'view.fit': () => ref.current?.canvasRef.current?.zoomToFit(),
      'view.actual': () => ref.current?.canvasRef.current?.zoomToActual(),
      'view.labels': () => toggleSetting('show_labels'),
      'view.crosshair': () => toggleSetting('show_crosshair'),
      'view.panels': () => useUi.getState().togglePanels(),
      'class.pick': () => {
        const w = ref.current
        const ids = sel()
        if (!w?.editable || ids.length === 0) return false
        st().openPicker({ mode: 'assign', ids, anchor: selectionAnchor(w, ids) })
      },
      'class.prev': () => ref.current?.actions.cycleClass(-1),
      'class.next': () => ref.current?.actions.cycleClass(1),
      'class.1': () => ref.current?.actions.classShortcut(1),
      'class.2': () => ref.current?.actions.classShortcut(2),
      'class.3': () => ref.current?.actions.classShortcut(3),
      'class.4': () => ref.current?.actions.classShortcut(4),
      'class.5': () => ref.current?.actions.classShortcut(5),
      'class.6': () => ref.current?.actions.classShortcut(6),
      'class.7': () => ref.current?.actions.classShortcut(7),
      'class.8': () => ref.current?.actions.classShortcut(8),
      'class.9': () => ref.current?.actions.classShortcut(9),
      'select.all': () => ref.current?.actions.selectAll(),
      'select.none': () => {
        const s = st()
        if (s.contextMenu) s.setContextMenu(null)
        else if (s.placingPin) s.setPlacingPin(false)
        else if (s.preview) s.setPreview(null)
        else if (s.selectedIds.length) s.select([])
        else return false
      },
      'select.cycle': () => {
        if (!focusIsOnCanvasOrBody()) return false
        ref.current?.actions.cycleSelection()
      },
      'image.prev': () => ref.current?.nav.goPrev(),
      'image.next': () => ref.current?.nav.goNext(),
      'image.submit': () => {
        const w = ref.current
        const me = useSession.getState().user
        if (!w?.image || !me || !w.editable) return false
        if (!reviewActions(w.image, w.project.permissions, w.project.settings.require_review, me.id).submit) return false
        void w.changeStatus('submit')
      },
      'image.flag': () => {
        if (!ref.current?.project.permissions.can_edit) return false
        ref.current.toggleFlag()
      },
      save: () => {
        void ref.current?.doc.save()
      },
      undo: () => {
        if (ref.current?.editable) ref.current.doc.undo()
      },
      redo: () => {
        if (ref.current?.editable) ref.current.doc.redo()
      },
      'box.delete': () => {
        const ids = sel()
        if (!ref.current?.editable || ids.length === 0) return false
        ref.current.actions.remove(ids)
      },
      'box.duplicate': () => {
        // Always consumed (Mod+D would otherwise bookmark the page mid-annotation).
        const ids = sel()
        if (ids.length) ref.current?.actions.duplicate(ids)
      },
      'box.copy': () => {
        const ids = sel()
        if (ids.length === 0 || window.getSelection()?.toString()) return false
        ref.current?.actions.copy(ids)
      },
      'box.paste': () => {
        if (!st().clipboard?.length || !ref.current?.editable) return false
        ref.current.actions.paste()
      },
      'box.pastePrevious': () => {
        void ref.current?.actions.pastePrevious()
      },
    },
    {
      raw: (e, combo) => {
        // Arrows nudge the selection; without a selection they fall through to image.prev / image.next.
        if (!combo || !ARROW_RE.test(combo)) return false
        const w = ref.current
        if (!w?.editable || sel().length === 0) return false
        const step = e.shiftKey ? 10 : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        w.actions.nudge(dx, dy)
        return true
      },
    },
  )

  // Hold Space to pan temporarily.
  useEffect(() => {
    const isSpace = (e: KeyboardEvent) => e.code === 'Space' || e.key === ' '
    const down = (e: KeyboardEvent) => {
      if (!isSpace(e) || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e.target)) return
      if (e.target instanceof Element && e.target.closest('button,[role="button"],a,[role="dialog"],[role="menu"]')) return
      e.preventDefault()
      if (!e.repeat) useAnnotator.getState().setSpacePan(true)
    }
    const up = (e: KeyboardEvent) => {
      if (isSpace(e)) useAnnotator.getState().setSpacePan(false)
    }
    const blur = () => useAnnotator.getState().setSpacePan(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      useAnnotator.getState().setSpacePan(false)
    }
  }, [])
}
