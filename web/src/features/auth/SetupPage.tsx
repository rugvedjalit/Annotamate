import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { CircleAlert, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { setupAdmin } from '@/lib/endpoints'
import { ApiError, errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import type { AuthState } from '@/lib/types'
import { useSession } from '@/stores/session'
import { useAuthState } from '@/hooks/useAuthState'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { LoadingBlock } from '@/components/ui/Feedback'
import { AuthLayout } from './AuthLayout'
import { PasswordInput } from './PasswordInput'
import { suggestUsername, validatePassword, validateUsername } from './validation'

export function SetupPage() {
  const auth = useAuthState()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const setUser = useSession((s) => s.setUser)
  const [displayName, setDisplayName] = useState('')
  const [username, setUsername] = useState('')
  const [usernameEdited, setUsernameEdited] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [touched, setTouched] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  if (auth.isPending) return <LoadingBlock className="h-full" />
  if (auth.data && !auth.data.setup_required) return <Navigate to={auth.data.user ? '/' : '/login'} replace />

  const errors = {
    display_name: !displayName.trim() ? 'Enter your name.' : null,
    username: validateUsername(username) ?? fieldErrors.username ?? null,
    password: validatePassword(password) ?? fieldErrors.password ?? null,
    confirm: confirm !== password ? 'The passwords do not match.' : null,
  }
  const invalid = Object.values(errors).some(Boolean)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (invalid) return
    setBusy(true)
    setError(null)
    try {
      const user = await setupAdmin({ username, display_name: displayName.trim(), password })
      setUser(user)
      qc.setQueryData<AuthState>(qk.authState, { setup_required: false, user })
      toast.success('Administrator account created', { description: 'Next, create your first project.' })
      navigate('/', { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'setup_done') {
        toast.info('Setup was already completed. Please sign in.')
        await qc.invalidateQueries({ queryKey: qk.authState })
        navigate('/login', { replace: true })
        return
      }
      if (err instanceof ApiError && err.status === 422) setFieldErrors(err.fieldErrors())
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const show = (k: keyof typeof errors) => (touched ? errors[k] : null)

  return (
    <AuthLayout
      title="Create the administrator account"
      subtitle="This is a new Annotamate server. The first account manages users and projects."
    >
      <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm">
            <CircleAlert className="mt-px size-4 shrink-0 text-danger" aria-hidden />
            {error}
          </div>
        )}
        <Field label="Your name" htmlFor="setup-name" error={show('display_name')}>
          <Input
            id="setup-name"
            size="lg"
            autoFocus
            autoComplete="name"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value)
              if (!usernameEdited) setUsername(suggestUsername(e.target.value))
            }}
            aria-invalid={!!show('display_name')}
          />
        </Field>
        <Field
          label="Username"
          htmlFor="setup-username"
          hint="Lowercase letters, digits, “_”, “.” or “-”. Used to sign in and for @mentions."
          error={show('username')}
        >
          <Input
            id="setup-username"
            size="lg"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            className="font-mono"
            onChange={(e) => {
              setUsernameEdited(true)
              setFieldErrors((f) => ({ ...f, username: '' }))
              setUsername(e.target.value.toLowerCase().replace(/\s/g, ''))
            }}
            aria-invalid={!!show('username')}
            aria-describedby="setup-username-desc"
          />
        </Field>
        <Field label="Password" htmlFor="setup-password" hint="At least 8 characters." error={show('password')}>
          <PasswordInput
            id="setup-password"
            size="lg"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!show('password')}
            aria-describedby="setup-password-desc"
          />
        </Field>
        <Field label="Confirm password" htmlFor="setup-confirm" error={show('confirm')}>
          <PasswordInput
            id="setup-confirm"
            size="lg"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={!!show('confirm')}
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-1 w-full">
          <ShieldCheck />
          Create administrator
        </Button>
      </form>
    </AuthLayout>
  )
}
