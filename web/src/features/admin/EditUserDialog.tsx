import { useState, type FormEvent } from 'react'
import type { User } from '@/lib/types'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { SwitchRow } from '@/components/ui/Switch'
import { useUpdateUser } from './useUserMutations'

interface EditUserDialogProps {
  user: User | null
  isSelf: boolean
  onOpenChange: (open: boolean) => void
}

export function EditUserDialog({ user, isSelf, onOpenChange }: EditUserDialogProps) {
  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      {user && <EditUserForm key={user.id} user={user} isSelf={isSelf} onDone={() => onOpenChange(false)} />}
    </Dialog>
  )
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function EditUserForm({ user, isSelf, onDone }: { user: User; isSelf: boolean; onDone: () => void }) {
  const update = useUpdateUser()
  const [displayName, setDisplayName] = useState(user.display_name)
  const [email, setEmail] = useState(user.email ?? '')
  const [isAdmin, setIsAdmin] = useState(user.is_admin)
  const nameError = !displayName.trim() ? 'Enter a name.' : null
  const emailError = email.trim() && !EMAIL_RE.test(email.trim()) ? 'Enter a valid email address.' : null
  const changed =
    displayName.trim() !== user.display_name || (email.trim() || null) !== user.email || isAdmin !== user.is_admin

  function submit(e: FormEvent) {
    e.preventDefault()
    if (nameError || emailError || !changed) return
    update.mutate(
      {
        id: user.id,
        body: {
          display_name: displayName.trim(),
          email: email.trim() || null,
          ...(isAdmin !== user.is_admin ? { is_admin: isAdmin } : {}),
        },
        success: `Saved changes to ${displayName.trim()}`,
      },
      { onSuccess: onDone },
    )
  }

  return (
    <DialogContent
      title={`Edit ${user.display_name}`}
      description={`@${user.username}`}
      footer={
        <>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="edit-user-form" loading={update.isPending} disabled={!changed}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="edit-user-form" onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field label="Name" htmlFor="eu-name" error={nameError}>
          <Input id="eu-name" autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} aria-invalid={!!nameError} />
        </Field>
        <Field label="Email" htmlFor="eu-email" hint="Optional." error={emailError}>
          <Input id="eu-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!emailError} />
        </Field>
        <SwitchRow
          label="Administrator"
          description={isSelf ? 'You cannot remove your own administrator rights.' : 'Can manage user accounts and all projects.'}
          checked={isAdmin}
          disabled={isSelf}
          onCheckedChange={setIsAdmin}
          className="rounded-lg border border-line bg-panel-2 px-3"
        />
      </form>
    </DialogContent>
  )
}
