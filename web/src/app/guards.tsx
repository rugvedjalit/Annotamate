import { useEffect, type ReactNode } from 'react'
import { Link, Navigate, useLocation } from 'react-router'
import { ShieldAlert } from 'lucide-react'
import { useAuthState } from '@/hooks/useAuthState'
import { useSession } from '@/stores/session'
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/Feedback'
import { Logo } from '@/components/brand/Logo'
import { Button } from '@/components/ui/Button'

function FullPage({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-bg p-6">
      <Logo variant="wordmark" height={30} />
      {children}
    </div>
  )
}

/** Only renders children for a signed-in user; otherwise redirects to /setup or /login?next=… */
export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation()
  const auth = useAuthState()
  const user = useSession((s) => s.user)
  const setUser = useSession((s) => s.setUser)
  const serverUser = auth.data?.user ?? null

  useEffect(() => {
    if (serverUser) setUser(serverUser)
  }, [serverUser, setUser])

  if (auth.isPending) {
    return (
      <FullPage>
        <LoadingBlock className="min-h-0" />
      </FullPage>
    )
  }
  if (auth.isError) {
    return (
      <FullPage>
        <ErrorState
          title="Cannot reach the Annotamate server"
          error={auth.error}
          onRetry={() => void auth.refetch()}
        />
      </FullPage>
    )
  }
  if (auth.data.setup_required) return <Navigate to="/setup" replace />
  if (!serverUser) {
    const next = location.pathname + location.search
    return <Navigate to={next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login'} replace />
  }
  if (!user) {
    return (
      <FullPage>
        <LoadingBlock className="min-h-0" />
      </FullPage>
    )
  }
  return <>{children}</>
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const user = useSession((s) => s.user)
  if (!user?.is_admin) {
    return (
      <EmptyState
        className="h-full"
        icon={<ShieldAlert />}
        title="Administrators only"
        description="You need administrator rights to open this page."
        action={
          <Button asChild variant="secondary">
            <Link to="/">Back to projects</Link>
          </Button>
        }
      />
    )
  }
  return <>{children}</>
}
