import { Crosshair, FileText, Lock } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { findCachedImage } from '@/lib/cacheUpdates'
import { formatCombo } from '@/lib/keymap'
import { formatPx } from '@/lib/format'
import { useBindings } from '@/hooks/useBindings'
import { useRealtime } from '@/stores/realtime'
import { useSession } from '@/stores/session'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { KeyCap } from '@/components/ui/Kbd'
import { cn } from '@/lib/utils'
import { useAnnotator } from './store'
import { useWorkspace } from './workspaceContext'

function Sep() {
  return <span className="h-3 w-px shrink-0 bg-line" aria-hidden />
}

/** Cursor, image size, objects, label path, autosave state, lock state, teammates here. */
export function StatusBar() {
  const ws = useWorkspace()
  const qc = useQueryClient()
  const cursor = useAnnotator((s) => s.cursor)
  const autosave = useSettings((s) => s.settings.autosave)
  const saveCombo = useBindings().save[0]
  const meId = useSession((s) => s.user?.id)
  const presence = useRealtime((s) => (s.presenceProjectId === ws.projectId ? s.presence : null))
  const setShortcutsOpen = useUi((s) => s.setShortcutsOpen)
  const others = Object.values(presence ?? {}).filter((p) => p.user.id !== meId)
  const here = others.filter((p) => p.imageId === ws.imageId)
  const elsewhere = others.filter((p) => p.imageId !== ws.imageId && p.imageId !== null)
  const { image } = ws

  let teammates = ''
  if (here.length) {
    teammates = `${here.map((p) => p.user.display_name).join(', ')} ${here.length === 1 ? 'is' : 'are'} also on this image`
  } else if (elsewhere.length === 1) {
    const p = elsewhere[0]!
    const img = findCachedImage(qc, ws.projectId, p.imageId!)
    teammates = `${p.user.display_name} is on ${img?.filename ?? `image #${p.imageId}`}`
  } else if (others.length) {
    teammates = `${others.length} teammates in this project`
  }

  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-3.5 overflow-hidden whitespace-nowrap border-t border-line bg-panel px-3 text-xs text-muted">
      <span className="flex items-center gap-1.5">
        <Crosshair className="size-3" aria-hidden />
        <span className="w-24 font-mono tabular">{cursor ? `${formatPx(Math.round(cursor.x))}, ${formatPx(Math.round(cursor.y))} px` : ''}</span>
      </span>
      <Sep />
      <span className="font-mono">{image?.width && image.height ? `${image.width} × ${image.height}` : '–'}</span>
      <Sep />
      <span>
        {ws.doc.boxes.length} object{ws.doc.boxes.length === 1 ? '' : 's'}
      </span>
      {image?.label_path && (
        <>
          <Sep />
          <span className="hidden min-w-0 items-center gap-1.5 lg:flex" title={image.label_path}>
            <FileText className="size-3 shrink-0" aria-hidden />
            <span className="truncate font-mono">{image.label_path}</span>
          </span>
        </>
      )}
      <span className="flex-1" />
      {ws.lock.status === 'unavailable' && (
        <>
          <span className="flex items-center gap-1.5 text-warn">
            <Lock className="size-3" aria-hidden />
            Live lock unavailable
          </span>
          <Sep />
        </>
      )}
      <span className="flex items-center gap-1.5">
        <span className={cn('size-[7px] rounded-full', autosave ? 'bg-ok' : 'bg-dim')} aria-hidden />
        {autosave ? 'Autosave on' : `Autosave off · ${saveCombo ? formatCombo(saveCombo) : 'Save'} to save`}
      </span>
      {teammates && (
        <>
          <Sep />
          <span className="hidden max-w-72 truncate xl:inline">{teammates}</span>
        </>
      )}
      <Sep />
      <button type="button" onClick={() => setShortcutsOpen(true)} className="flex items-center gap-1.5 hover:text-fg">
        <KeyCap>?</KeyCap>
        Shortcuts
      </button>
    </footer>
  )
}
