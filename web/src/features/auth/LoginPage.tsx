import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { CircleAlert } from 'lucide-react'
import { login } from '@/lib/endpoints'
import { ApiError, errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import type { AuthState, User } from '@/lib/types'
import { useSession } from '@/stores/session'
import { useAuthState } from '@/hooks/useAuthState'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { LoadingBlock } from '@/components/ui/Feedback'
import { AuthLayout } from './AuthLayout'
import { safeNext } from './validation'
import { PasswordInput } from './PasswordInput'

function loginErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_credentials' || err.status === 401) return 'Incorrect username or password.'
    if (err.code === 'rate_limited') return 'Too many failed attempts. Wait a few minutes, then try again.'
  }
  return errorMessage(err)
}

/** The sign-in form (exported separately for tests). */
export function LoginForm({ onSuccess }: { onSuccess: (user: User) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [touched, setTouched] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    if (!username.trim() || !password) return
    setBusy(true)
    setError(null)
    try {
      const user = await login({ username: username.trim().toLowerCase(), password })
      onSuccess(user)
    } catch (err) {
      setError(loginErrorText(err))
      setPassword('')
      setTouched(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-fg">
          <CircleAlert className="mt-px size-4 shrink-0 text-danger" aria-hidden />
          {error}
        </div>
      )}
      <Field label="Username" htmlFor="login-username" error={touched && !username.trim() ? 'Enter your username.' : null}>
        <Input
          id="login-username"
          size="lg"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          aria-invalid={touched && !username.trim()}
        />
      </Field>
      <Field label="Password" htmlFor="login-password" error={touched && !password ? 'Enter your password.' : null}>
        <PasswordInput
          id="login-password"
          size="lg"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={touched && !password}
        />
      </Field>
      <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-1 w-full">
        Sign in
      </Button>
      <p className="text-center text-xs text-muted">Forgot your password? Ask an administrator to reset it.</p>
    </form>
  )
}

export function LoginPage() {
  const auth = useAuthState()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const setUser = useSession((s) => s.setUser)
  const next = safeNext(params.get('next'))

  if (auth.isPending) return <LoadingBlock className="h-full" />
  if (auth.data?.setup_required) return <Navigate to="/setup" replace />
  if (auth.data?.user) return <Navigate to={next} replace />

  return (
    <AuthLayout title="Sign in" subtitle="Welcome back. Sign in to continue annotating with your team.">
      <LoginForm
        onSuccess={(user) => {
          setUser(user)
          qc.setQueryData<AuthState>(qk.authState, { setup_required: false, user })
          navigate(next, { replace: true })
        }}
      />
    </AuthLayout>
  )
}
