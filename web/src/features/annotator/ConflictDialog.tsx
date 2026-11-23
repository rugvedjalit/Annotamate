import { useState } from 'react'
import { Copy, GitMerge } from 'lucide-react'
import { AlertDialog, AlertDialogContent } from '@/components/ui/AlertDialog'
import { Button } from '@/components/ui/Button'
import { Avatar } from '@/components/ui/Avatar'
import { relativeTime } from '@/lib/format'
import { useWorkspace } from './workspaceContext'

/** 409 conflict: never silently overwrite — the user chooses theirs or mine. */
export function ConflictDialog() {
  const ws = useWorkspace()
  const conflict = ws.doc.state.conflict
  const [busy, setBusy] = useState(false)
  if (!conflict) return null
  const mine = ws.doc.boxes.length
  const theirs = conflict.boxes.length

  return (
    <AlertDialog open>
      <AlertDialogContent
        title="Someone else saved this image"
        icon={
          <div className="grid size-8 place-items-center rounded-full bg-warn-soft">
            <GitMerge className="size-4 text-warn" />
          </div>
        }
        description={
          <>
            A newer version was saved
            {conflict.updated_by ? ` by ${conflict.updated_by.display_name}` : ''}
            {conflict.updated_at ? ` ${relativeTime(conflict.updated_at)}` : ''}. Your changes have not been saved yet.
          </>
        }
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => ws.actions.copy(ws.doc.boxes.map((b) => b.id))} className="mr-auto">
              <Copy />
              Copy mine
            </Button>
            <Button variant="secondary" disabled={busy} onClick={ws.doc.resolveTheirs}>
              Load theirs
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  await ws.doc.keepMine()
                } finally {
                  setBusy(false)
                }
              }}
            >
              Keep mine
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg border border-line bg-panel-2 p-3">
            <div className="flex items-center gap-2 text-muted">
              {conflict.updated_by && <Avatar user={conflict.updated_by} size="xs" tooltip={false} />}
              Theirs
            </div>
            <div className="mt-1 font-mono text-md text-fg">{theirs} boxes</div>
          </div>
          <div className="rounded-lg border border-accent/40 bg-accent-soft p-3">
            <div className="text-muted">Mine (unsaved)</div>
            <div className="mt-1 font-mono text-md text-fg">{mine} boxes</div>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted">
          “Load theirs” discards your changes (undo brings them back). “Keep mine” saves your version; theirs stays
          in the image history.
        </p>
      </AlertDialogContent>
    </AlertDialog>
  )
}
