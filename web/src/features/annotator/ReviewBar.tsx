import { useState } from 'react'
import { Check, Flag, RotateCcw, Send, X } from 'lucide-react'
import { useBindings } from '@/hooks/useBindings'
import { useSession } from '@/stores/session'
import { Button } from '@/components/ui/Button'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { Field } from '@/components/ui/Field'
import { Textarea } from '@/components/ui/Input'
import { Kbd } from '@/components/ui/Kbd'
import { Tooltip } from '@/components/ui/Tooltip'
import { Avatar } from '@/components/ui/Avatar'
import { StatusBadge } from '@/components/StatusIcon'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { reviewActions } from './reviewActions'
import { useWorkspace } from './workspaceContext'

function RejectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const ws = useWorkspace()
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [touched, setTouched] = useState(false)
  const error = touched && !reason.trim() ? 'Explain what needs to change.' : null

  async function submit() {
    setTouched(true)
    if (!reason.trim()) return
    setBusy(true)
    try {
      if (await ws.changeStatus('reject', reason.trim())) {
        setReason('')
        setTouched(false)
        onOpenChange(false)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent
        size="sm"
        title="Reject this image"
        description="The annotator is notified and the reason is added to the image's comments."
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void submit()}>
              Reject
            </Button>
          </>
        }
      >
        <Field label="Reason" htmlFor="reject-reason" required error={error}>
          <Textarea
            id="reject-reason"
            autoFocus
            rows={4}
            maxLength={4000}
            value={reason}
            placeholder="e.g. Two pedestrians on the left are missing; the car box is too loose."
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                void submit()
              }
            }}
            aria-invalid={!!error}
          />
        </Field>
      </DialogContent>
    </Dialog>
  )
}

/** Status + Submit / Approve / Reject… / Reopen, depending on permissions and status. */
export function ReviewBar() {
  const ws = useWorkspace()
  const me = useSession((s) => s.user)
  const bindings = useBindings()
  const [rejectOpen, setRejectOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const image = ws.image
  if (!image || !me) return null
  const perms = ws.project.permissions
  if (!perms.can_edit && !perms.can_review) return null
  const actions = reviewActions(image, perms, ws.project.settings.require_review, me.id)

  async function run(action: 'submit' | 'approve' | 'reopen') {
    setBusy(action)
    try {
      await ws.changeStatus(action)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-t border-line bg-panel px-3">
      <StatusBadge status={image.status} size="md" />
      {image.flagged && (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-warn">
          <Flag className="size-3" aria-hidden />
          Flagged
        </span>
      )}
      {image.last_editor && (
        <span className="hidden min-w-0 items-center gap-1.5 truncate text-xs text-muted lg:flex">
          <Avatar user={image.last_editor} size="xs" tooltip={false} />
          Last edited by {image.last_editor.display_name}
          {image.updated_at ? ` · ${relativeTime(image.updated_at)}` : ''}
        </span>
      )}
      <div className="ml-auto flex items-center gap-2">
        {actions.reopen && (
          <Button size="sm" variant="secondary" loading={busy === 'reopen'} disabled={!!busy} onClick={() => void run('reopen')}>
            <RotateCcw />
            Reopen
          </Button>
        )}
        {actions.reject && (
          <Button size="sm" variant="danger-ghost" disabled={!!busy} onClick={() => setRejectOpen(true)}>
            <X />
            Reject…
          </Button>
        )}
        {actions.approve && (
          <Button size="sm" variant="success" loading={busy === 'approve'} disabled={!!busy} onClick={() => void run('approve')}>
            <Check />
            Approve
          </Button>
        )}
        {actions.submit && (
          <Tooltip
            content={ws.editable ? actions.submitHint : 'You need edit access to this image to submit it'}
            shortcut={bindings['image.submit']}
          >
            <span>
              <Button
                size="sm"
                variant="primary"
                loading={busy === 'submit'}
                disabled={!!busy || !ws.editable}
                onClick={() => void run('submit')}
                className={cn(!ws.editable && 'pointer-events-none')}
              >
                <Send />
                {actions.submitLabel}
                {bindings['image.submit'][0] && <Kbd combo={bindings['image.submit'][0]} className="ml-1 opacity-80" />}
              </Button>
            </span>
          </Tooltip>
        )}
      </div>
      <RejectDialog open={rejectOpen} onOpenChange={setRejectOpen} />
    </div>
  )
}
