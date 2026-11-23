import { useState, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { AlertDialog, AlertDialogCancel, AlertDialogContent } from '@/components/ui/AlertDialog'
import { Button } from '@/components/ui/Button'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** May return a promise; the dialog shows a spinner and closes when it resolves. Throw to keep it open. */
  onConfirm: () => unknown
  confirmDisabled?: boolean
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  confirmDisabled,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false)

  async function confirm() {
    setBusy(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch {
      // the caller reports the error (toast); keep the dialog open
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <AlertDialogContent
        title={title}
        description={description}
        icon={
          danger ? (
            <div className="grid size-8 place-items-center rounded-full bg-danger-soft">
              <TriangleAlert className="size-4 text-danger" />
            </div>
          ) : undefined
        }
        footer={
          <>
            <AlertDialogCancel asChild>
              <Button variant="ghost" disabled={busy}>
                {cancelLabel}
              </Button>
            </AlertDialogCancel>
            <Button
              variant={danger ? 'danger' : 'primary'}
              loading={busy}
              disabled={confirmDisabled}
              onClick={() => void confirm()}
            >
              {confirmLabel}
            </Button>
          </>
        }
      >
        {children}
      </AlertDialogContent>
    </AlertDialog>
  )
}
