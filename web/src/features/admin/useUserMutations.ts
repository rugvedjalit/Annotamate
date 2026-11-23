import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { createUser, resetUserPassword, updateUser } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import type { AuthState, CreateUserBody, UpdateUserBody, User } from '@/lib/types'
import { useSession } from '@/stores/session'

function useSyncSelf() {
  const qc = useQueryClient()
  return (user: User) => {
    if (useSession.getState().user?.id !== user.id) return
    useSession.getState().patchUser(user)
    qc.setQueryData<AuthState>(qk.authState, (s) => (s ? { ...s, user: { ...s.user, ...user } } : s))
  }
}

export function useUpdateUser() {
  const qc = useQueryClient()
  const syncSelf = useSyncSelf()
  return useMutation({
    mutationFn: (v: { id: number; body: UpdateUserBody; success: string }) => updateUser(v.id, v.body),
    onSuccess: (user, v) => {
      syncSelf(user)
      void qc.invalidateQueries({ queryKey: qk.usersAll })
      toast.success(v.success)
    },
    onError: (err) => toast.error('Could not update the account', { description: errorMessage(err) }),
  })
}

/** Errors are shown inline by the create dialog (field errors), so no error toast here. */
export function useCreateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateUserBody) => createUser(body),
    onSuccess: (user) => {
      void qc.invalidateQueries({ queryKey: qk.usersAll })
      toast.success(`Account created for ${user.display_name}`, {
        description: `They can sign in as @${user.username}.`,
      })
    },
  })
}

export function useResetPassword() {
  return useMutation({
    mutationFn: (v: { user: User; password: string }) => resetUserPassword(v.user.id, v.password),
    onSuccess: (_r, v) =>
      toast.success(`Password reset for ${v.user.display_name}`, {
        description: 'They were signed out everywhere and must use the new password.',
      }),
    onError: (err) => toast.error('Could not reset the password', { description: errorMessage(err) }),
  })
}
