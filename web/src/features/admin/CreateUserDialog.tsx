import { useState, type FormEvent } from 'react'
import { Wand2 } from 'lucide-react'
import { ApiError, errorMessage } from '@/lib/api'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { SwitchRow } from '@/components/ui/Switch'
import { PasswordInput } from '@/features/auth/PasswordInput'
import { generatePassword, suggestUsername, validatePassword, validateUsername } from '@/features/auth/validation'
import { CopyButton } from './CopyButton'
import { useCreateUser } from './useUserMutations'

interface CreateUserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateUserDialog({ open, onOpenChange }: CreateUserDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <CreateUserForm onDone={() => onOpenChange(false)} />}
    </Dialog>
  )
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function CreateUserForm({ onDone }: { onDone: () => void }) {
  const create = useCreateUser()
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [usernameEdited, setUsernameEdited] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [touched, setTouched] = useState(false)
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)

  const errors = {
    display_name: !displayName.trim() ? 'Enter a name.' : (serverErrors.display_name ?? null),
    username: validateUsername(username) ?? serverErrors.username ?? null,
    email: email.trim() && !EMAIL_RE.test(email.trim()) ? 'Enter a valid email address.' : (serverErrors.email ?? null),
    password: validatePassword(password) ?? serverErrors.password ?? null,
  }
  const show = (k: keyof typeof errors) => (touched ? errors[k] : null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (Object.values(errors).some(Boolean)) return
    setFormError(null)
    try {
      await create.mutateAsync({
        username,
        display_name: displayName.trim(),
        password,
        email: email.trim() || null,
        is_admin: isAdmin,
      })
      onDone()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'exists') {
        setServerErrors({ username: 'This username is already taken.' })
      } else if (err instanceof ApiError && err.status === 422) {
        setServerErrors(err.fieldErrors())
        setFormError(errorMessage(err))
      } else {
        setFormError(errorMessage(err))
      }
    }
  }

  return (
    <DialogContent
      title="Create user"
      description="The new member signs in with this username and password. Share the password with them securely."
      footer={
        <>
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="create-user-form" loading={create.isPending}>
            Create user
          </Button>
        </>
      }
    >
      <form id="create-user-form" onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        {formError && (
          <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm">
            {formError}
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="cu-name" required error={show('display_name')}>
            <Input
              id="cu-name"
              autoFocus
              value={displayName}
              aria-invalid={!!show('display_name')}
              onChange={(e) => {
                setDisplayName(e.target.value)
                if (!usernameEdited) setUsername(suggestUsername(e.target.value))
              }}
            />
          </Field>
          <Field label="Username" htmlFor="cu-username" required error={show('username')}>
            <Input
              id="cu-username"
              className="font-mono"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              aria-invalid={!!show('username')}
              onChange={(e) => {
                setUsernameEdited(true)
                setServerErrors((s) => ({ ...s, username: '' }))
                setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))
              }}
            />
          </Field>
        </div>
        <Field label="Email" htmlFor="cu-email" hint="Optional." error={show('email')}>
          <Input
            id="cu-email"
            type="email"
            autoComplete="off"
            value={email}
            aria-invalid={!!show('email')}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field
          label="Password"
          htmlFor="cu-password"
          required
          hint="At least 8 characters."
          error={show('password')}
          aside={
            <Button size="xs" variant="ghost" onClick={() => setPassword(generatePassword())}>
              <Wand2 />
              Generate
            </Button>
          }
        >
          <div className="flex items-center gap-1.5">
            <PasswordInput
              id="cu-password"
              wrapperClassName="flex-1"
              className="font-mono"
              autoComplete="new-password"
              value={password}
              aria-required
              aria-invalid={!!show('password')}
              onChange={(e) => setPassword(e.target.value)}
            />
            <CopyButton text={password} label="Copy password" />
          </div>
        </Field>
        <SwitchRow
          label="Administrator"
          description="Can manage user accounts and create or delete any project."
          checked={isAdmin}
          onCheckedChange={setIsAdmin}
          className="rounded-lg border border-line bg-panel-2 px-3"
        />
      </form>
    </DialogContent>
  )
}
