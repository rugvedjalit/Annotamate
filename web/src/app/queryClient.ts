import { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ApiError, setUnauthorizedHandler } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import { useSession } from '@/stores/session'

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408) return false
          return failureCount < 2
        },
        refetchOnWindowFocus: false,
        staleTime: 10_000,
      },
      mutations: { retry: false },
    },
  })
}

export const queryClient = createQueryClient()

let expiredToastShown = false

/** A 401 anywhere: drop the session; RequireAuth then redirects to /login?next=… */
setUnauthorizedHandler(() => {
  if (!useSession.getState().user) return
  useSession.getState().clear()
  queryClient.setQueryData(qk.authState, { setup_required: false, user: null })
  if (!expiredToastShown) {
    expiredToastShown = true
    toast.error('Your session has expired', { description: 'Please sign in again.' })
    setTimeout(() => (expiredToastShown = false), 5000)
  }
})
