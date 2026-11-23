import { useQuery } from '@tanstack/react-query'
import { getAuthState } from '@/lib/endpoints'
import { qk } from '@/lib/queryKeys'

export function useAuthState() {
  return useQuery({
    queryKey: qk.authState,
    queryFn: ({ signal }) => getAuthState({ signal }),
    staleTime: Infinity,
    retry: 1,
  })
}
