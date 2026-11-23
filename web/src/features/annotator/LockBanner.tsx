import { Copy, Eye, FileLock2, ImageOff, Lock, MonitorSmartphone, Tags, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Feedback'
import { cn } from '@/lib/utils'
import { useSession } from '@/stores/session'
import { useAnnotator } from './store'
import { useWorkspace } from './workspaceContext'

const ICONS = {
  permission: Eye,
  locked: Lock,
  revoked: Lock,
  assigned: UserRound,
  migrating: Tags,
  file: FileLock2,
  image: ImageOff,
  device: MonitorSmartphone,
} as const

/** Why the image is read-only ("Alice is editing this image…"), with take-over for managers. */
export function LockBanner() {
  const ws = useWorkspace()
  const meId = useSession((s) => s.user?.id)
  const preview = useAnnotator((s) => s.preview)
  const ro = ws.readOnly
  if (!ro || ro.kind === 'preview' || preview) return null

  if (ro.kind === 'acquiring') {
    return (
      <div role="status" className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-sm text-muted">
        <Spinner className="size-3.5" />
        Requesting the edit lock…
      </div>
    )
  }

  const Icon = ICONS[ro.kind]
  const hasLocalChanges = ws.doc.state.dirty
  // The lock moved to another tab of this user: taking it back needs no special rights.
  const ownOtherTab = ro.kind === 'revoked' && !!ro.holder && ro.holder.id === meId
  const canTakeOver = (ro.kind === 'locked' || ro.kind === 'revoked') && (ws.project.permissions.can_manage || ownOtherTab)
  const tone = ro.kind === 'locked' || ro.kind === 'revoked' ? 'warn' : ro.kind === 'image' || ro.kind === 'file' ? 'danger' : 'neutral'

  return (
    <div
      role="status"
      className={cn(
        'flex min-h-9 shrink-0 items-center gap-2.5 border-b px-3 py-1.5 text-sm',
        tone === 'warn' && 'border-warn/30 bg-warn-soft',
        tone === 'danger' && 'border-danger/30 bg-danger-soft',
        tone === 'neutral' && 'border-line bg-panel',
      )}
    >
      {ro.kind === 'migrating' ? (
        <Spinner className="size-3.5 shrink-0" />
      ) : (
        <Icon className={cn('size-4 shrink-0', tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-muted')} aria-hidden />
      )}
      <span className="min-w-0 flex-1 text-fg">{ro.message}</span>
      {ro.kind === 'revoked' && hasLocalChanges && (
        <Button size="xs" variant="secondary" onClick={() => ws.actions.copy(ws.doc.boxes.map((b) => b.id))}>
          <Copy />
          Copy my boxes
        </Button>
      )}
      {canTakeOver && (
        <Button size="xs" variant="warn" onClick={ws.lock.takeOver}>
          {ownOtherTab ? 'Edit here' : 'Take over'}
        </Button>
      )}
    </div>
  )
}
