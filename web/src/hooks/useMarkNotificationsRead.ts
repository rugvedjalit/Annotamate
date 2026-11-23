import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { markNotificationsRead } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { setNotificationsRead } from '@/lib/cacheUpdates'

/** Mark notifications read (optimistically) and keep the unread badge in sync. */
export function useMarkNotificationsRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { ids?: number[]; all?: boolean }) => markNotificationsRead(body),
    onSuccess: (res, body) => setNotificationsRead(qc, body.all ? 'all' : (body.ids ?? []), res.unread_count),
    onError: (err) => toast.error('Could not update notifications', { description: errorMessage(err) }),
  })
}
