import { useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { changePassword } from '@/lib/endpoints'
import { ApiError, errorMessage } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { PasswordInput } from '@/features/auth/PasswordInput'
import { validatePassword } from '@/features/auth/validation'
import { SettingsCard } from './SettingsCard'

export function PasswordSection() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [touched, setTouched] = useState(false)
  const [currentError, setCurrentError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => changePassword({ current_password: current, new_password: next }),
    onSuccess: () => {
      setCurrent('')
      setNext('')
      setConfirm('')
      setTouched(false)
      toast.success('Password changed', { description: 'You were signed out of every other device.' })
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 400) setCurrentError('Current password is incorrect.')
      else toast.error('Could not change your password', { description: errorMessage(err) })
    },
  })

  const errors = {
    current: !current ? 'Enter your current password.' : currentError,
    next: validatePassword(next) ?? (next && next === current ? 'Choose a password different from the current one.' : null),
    confirm: confirm !== next ? 'The passwords do not match.' : null,
  }
  const show = (k: keyof typeof errors) => (touched ? errors[k] : null)

  function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (Object.values(errors).some(Boolean)) return
    mutation.mutate()
  }

  return (
    <form onSubmit={submit} noValidate>
      <SettingsCard
        title="Password"
        description="Changing your password signs you out everywhere else."
        footer={
          <Button type="submit" variant="primary" loading={mutation.isPending}>
            Change password
          </Button>
        }
      >
        <div className="flex max-w-md flex-col gap-4">
          <Field label="Current password" htmlFor="pw-current" error={show('current')}>
            <PasswordInput
              id="pw-current"
              autoComplete="current-password"
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value)
                setCurrentError(null)
              }}
              aria-invalid={!!show('current')}
            />
          </Field>
          <Field label="New password" htmlFor="pw-next" hint="At least 8 characters." error={show('next')}>
            <PasswordInput
              id="pw-next"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              aria-invalid={!!show('next')}
              aria-describedby="pw-next-desc"
            />
          </Field>
          <Field label="Confirm new password" htmlFor="pw-confirm" error={show('confirm')}>
            <PasswordInput
              id="pw-confirm"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-invalid={!!show('confirm')}
            />
          </Field>
        </div>
      </SettingsCard>
    </form>
  )
}
