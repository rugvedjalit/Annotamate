import { ClipboardPaste, Copy, CopyPlus, Eye, EyeOff, Files, Lock, LockOpen, Maximize, SquareMousePointer, Tag, Trash2 } from 'lucide-react'
import { useBindings } from '@/hooks/useBindings'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { useAnnotator } from './store'
import { useWorkspace } from './workspaceContext'

/** Right-click menu on the canvas (box actions, paste, select all, fit). */
export function BoxContextMenu() {
  const ws = useWorkspace()
  const bindings = useBindings()
  const menu = useAnnotator((s) => s.contextMenu)
  const setMenu = useAnnotator((s) => s.setContextMenu)
  const selectedIds = useAnnotator((s) => s.selectedIds)
  const clipboard = useAnnotator((s) => s.clipboard)
  const openPicker = useAnnotator((s) => s.openPicker)
  if (!menu) return null

  const ids = menu.boxId ? (selectedIds.includes(menu.boxId) ? selectedIds : [menu.boxId]) : selectedIds
  const boxes = ws.doc.boxes.filter((b) => ids.includes(b.id))
  const hasBoxes = boxes.length > 0
  const allLocked = hasBoxes && boxes.every((b) => b.locked)
  const allHidden = hasBoxes && boxes.every((b) => b.hidden)
  const first = (list: string[]) => list[0]

  return (
    <DropdownMenu open onOpenChange={(open) => !open && setMenu(null)} modal={false}>
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          className="pointer-events-none fixed size-px"
          style={{ left: menu.clientX, top: menu.clientY }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={2} className="w-60">
        {hasBoxes && (
          <>
            <DropdownMenuItem
              icon={<Tag />}
              shortcut={first(bindings['class.pick'])}
              disabled={!ws.editable}
              onSelect={() => openPicker({ mode: 'assign', ids, anchor: { x: menu.clientX, y: menu.clientY } })}
            >
              Change class…
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<CopyPlus />}
              shortcut={first(bindings['box.duplicate'])}
              disabled={!ws.editable}
              onSelect={() => ws.actions.duplicate(ids)}
            >
              Duplicate
            </DropdownMenuItem>
            <DropdownMenuItem icon={<Copy />} shortcut={first(bindings['box.copy'])} onSelect={() => ws.actions.copy(ids)}>
              Copy
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={allLocked ? <LockOpen /> : <Lock />}
              onSelect={() => ws.actions.toggleLocked(ids)}
            >
              {allLocked ? 'Unlock' : 'Lock'}
            </DropdownMenuItem>
            <DropdownMenuItem icon={allHidden ? <Eye /> : <EyeOff />} onSelect={() => ws.actions.toggleHidden(ids)}>
              {allHidden ? 'Show' : 'Hide'}
            </DropdownMenuItem>
            <DropdownMenuItem
              icon={<Trash2 />}
              danger
              shortcut={first(bindings['box.delete'])}
              disabled={!ws.editable}
              onSelect={() => ws.actions.remove(ids)}
            >
              Delete
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          icon={<ClipboardPaste />}
          shortcut={first(bindings['box.paste'])}
          disabled={!ws.editable || !clipboard?.length}
          onSelect={() => ws.actions.paste()}
        >
          Paste{clipboard?.length ? ` ${clipboard.length} box${clipboard.length === 1 ? '' : 'es'}` : ''}
        </DropdownMenuItem>
        <DropdownMenuItem
          icon={<Files />}
          shortcut={first(bindings['box.pastePrevious'])}
          disabled={!ws.editable}
          onSelect={() => void ws.actions.pastePrevious()}
        >
          Paste previous image’s boxes
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<SquareMousePointer />} shortcut={first(bindings['select.all'])} onSelect={() => ws.actions.selectAll()}>
          Select all
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Maximize />} shortcut={first(bindings['view.fit'])} onSelect={() => ws.canvasRef.current?.zoomToFit()}>
          Zoom to fit
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
