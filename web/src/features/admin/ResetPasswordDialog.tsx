import { useState, type FormEvent } from 'react'
import { TriangleAlert, Wand2 } from 'lucide-react'
import type { User } from '@/lib/types'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { PasswordInput } from '@/features/auth/PasswordInput'
import { generatePassword, validatePassword } from '@/features/auth/validation'
import { CopyButton } from './CopyButton'
import { useResetPassword } from './useUserMutations'

interface ResetPasswordDialogProps {
  /** The user and a pre-generated password (generated when the dialog was opened). */
  target: { user: User; initial: string } | null
  onOpenChange: (open: boolean) => void
}

export function ResetPasswordDialog({ target, onOpenChange }: ResetPasswordDialogProps) {
  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      {target && (
        <ResetPasswordForm key={target.user.id} user={target.user} initial={target.initial} onDone={() => onOpenChange(false)} />
      )}
    </Dialog>
  )
}

function ResetPasswordForm({ user, initial, onDone }: { user: User; initial: string; onDone: () => void }) {
  const reset = useResetPassword()
  const [password, setPassword] = useState(initial)
  const error = validatePassword(password)

  function submit(e: FormEvent) {
    e.preventDefault()
    if (error) return
    reset.mutate({ user, password }, { onSuccess: onDone })
  }

  return (
    <DialogContent
      size="sm"
      title={`Reset password for ${user.display_name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="reset-password-form" loading={reset.isPending} disabled={!!error}>
            Reset password
          </Button>
        </>
      }
    >
      <form id="reset-password-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        <div className="flex gap-2.5 rounded-md border border-warn/30 bg-warn-soft px-3 py-2.5 text-sm text-fg">
          <TriangleAlert className="mt-px size-4 shrink-0 text-warn" aria-hidden />
          <span>
            {user.display_name} will be signed out on every device and must sign in with the new password. Copy it now and
            share it securely.
          </span>
        </div>
        <Field
          label="New password"
          htmlFor="rp-password"
          error={error}
          aside={
            <Button size="xs" variant="ghost" onClick={() => setPassword(generatePassword())}>
              <Wand2 />
              Generate
            </Button>
          }
        >
          <div className="flex items-center gap-1.5">
            <PasswordInput
              id="rp-password"
              wrapperClassName="flex-1"
              className="font-mono"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!error}
            />
            <CopyButton text={password} label="Copy password" />
          </div>
        </Field>
      </form>
    </DialogContent>
  )
}
