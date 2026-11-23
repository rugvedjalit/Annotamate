import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { logout } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { imageCache } from '@/lib/imageCache'
import { useSession } from '@/stores/session'
import { useSettings } from '@/stores/settings'
import { realtime, useRealtime } from '@/stores/realtime'

/** Sign out everywhere in this tab: server session, socket, caches, local state. */
export function useSignOut() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  return async () => {
    try {
      await logout()
    } catch (err) {
      toast.error('Could not sign out cleanly', { description: errorMessage(err) })
    }
    realtime.disconnect()
    useRealtime.getState().reset()
    useSession.getState().clear()
    useSettings.getState().reset()
    imageCache.clear()
    qc.clear()
    navigate('/login', { replace: true })
  }
}
