import { create } from 'zustand'
import type { User } from '@/lib/types'

interface SessionState {
  user: User | null
  setUser: (user: User | null) => void
  patchUser: (patch: Partial<User>) => void
  clear: () => void
}

export const useSession = create<SessionState>()((set) => ({
  user: null,
  setUser: (user) => set({ user }),
  patchUser: (patch) => set((s) => (s.user ? { user: { ...s.user, ...patch } } : s)),
  clear: () => set({ user: null }),
}))

/** The signed-in user. Only use below RequireAuth (where it is always set). */
export function useMe(): User {
  const user = useSession((s) => s.user)
  if (!user) throw new Error('useMe() used outside an authenticated route')
  return user
}
