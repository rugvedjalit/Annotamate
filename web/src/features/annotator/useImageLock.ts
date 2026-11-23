// Edit lock for the open image over the WebSocket: acquire → granted | denied; revoked on take-over;
// re-acquired automatically when the holder leaves; released on image change/unmount.
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { UserBrief } from '@/lib/types'
import { realtime, useRealtime } from '@/stores/realtime'
import { useSession } from '@/stores/session'
import { reactToLockExpired, reactToLockState } from './lockLogic'

export type LockStatus =
  | 'disabled' // the user cannot edit this image anyway
  | 'acquiring' // waiting for the server (read-only until granted)
  | 'held'
  | 'denied' // someone else is editing
  | 'revoked' // someone took over from us
  | 'unavailable' // live connection down for a while: editing allowed, the server still refuses conflicting saves

export interface ImageLock {
  status: LockStatus
  holder: UserBrief | null
  /** Manager/admin take-over. */
  takeOver: () => void
  /** A save returned 423: someone else holds the lock. */
  markDenied: (holder: UserBrief | null) => void
}

const UNAVAILABLE_AFTER_MS = 4000

interface State {
  imageId: number
  status: LockStatus
  holder: UserBrief | null
}

export function useImageLock(imageId: number, wanted: boolean): ImageLock {
  const [state, setState] = useState<State>({ imageId, status: wanted ? 'acquiring' : 'disabled', holder: null })
  const connected = useRealtime((s) => s.connection === 'open')
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  })

  // Reset synchronously when the image or eligibility changes (no stale "held" for the next image).
  const expected: LockStatus = wanted ? 'acquiring' : 'disabled'
  const current = state.imageId === imageId && (wanted ? state.status !== 'disabled' : state.status === 'disabled') ? state : null
  if (!current) setState({ imageId, status: expected, holder: null })

  useEffect(() => {
    if (!wanted) return
    const me = () => useSession.getState().user?.id
    const set = (status: LockStatus, holder: UserBrief | null = null) => {
      // Keep the ref current right away: messages arriving in the same tick (revoked, then the new holder's
      // lock.state) must see the status the previous one set, not the last rendered one.
      if (stateRef.current.imageId === imageId) stateRef.current = { imageId, status, holder }
      setState((s) => (s.imageId === imageId ? { imageId, status, holder } : s))
    }

    const offs = [
      realtime.on('lock.granted', (m) => {
        if (m.image_id === imageId) set('held')
      }),
      realtime.on('lock.denied', (m) => {
        if (m.image_id === imageId) set('denied', m.holder)
      }),
      realtime.on('lock.revoked', (m) => {
        if (m.image_id !== imageId) return
        // Do not take it back on the next reconnect; it is requested again when the new holder leaves.
        realtime.forgetLock(imageId)
        set('revoked', m.by)
        if (!m.by) {
          toast.warning(m.reason ?? 'You can no longer edit this image', {
            description: 'You are now in read-only mode. Unsaved changes are kept in this tab; copy them if needed.',
          })
        } else if (m.by.id === me()) {
          toast.info('This image is now open for editing in another tab', {
            description: 'This tab is read-only until you choose to edit here again.',
          })
        } else {
          toast.warning(`${m.by.display_name} took over editing this image`, {
            description: 'You are now in read-only mode. Unsaved changes are kept in this tab; copy them if needed.',
          })
        }
      }),
      realtime.on('lock.state', (m) => {
        if (m.image_id !== imageId) return
        const reaction = reactToLockState(stateRef.current.status, m.holder, me())
        if (stateRef.current.imageId !== imageId) return
        if (reaction.kind === 'reacquire') {
          realtime.acquireLock(imageId)
          set('acquiring')
        } else if (reaction.kind === 'denied') {
          set('denied', reaction.holder)
        }
      }),
      // The server swept our lock for inactivity: ask again; if someone else got it meanwhile we end up read-only.
      realtime.on('lock.expired', (m) => {
        if (m.image_id !== imageId) return
        if (reactToLockExpired(stateRef.current.status).kind === 'reacquire') {
          realtime.acquireLock(imageId)
          set('acquiring')
        }
      }),
    ]
    realtime.acquireLock(imageId)
    return () => {
      for (const off of offs) off()
      realtime.releaseLock(imageId)
    }
  }, [imageId, wanted])

  // Live connection unavailable for a while: do not block editing (the server rejects conflicting saves
  // with 423, which drops us to read-only). Once reconnected, the lock request is replayed.
  useEffect(() => {
    if (!wanted || connected || state.status !== 'acquiring') return
    const t = setTimeout(
      () => setState((s) => (s.imageId === imageId && s.status === 'acquiring' ? { ...s, status: 'unavailable' } : s)),
      UNAVAILABLE_AFTER_MS,
    )
    return () => clearTimeout(t)
  }, [wanted, connected, state.status, imageId])

  useEffect(() => {
    if (connected && state.status === 'unavailable') {
      const t = setTimeout(() => setState((s) => (s.status === 'unavailable' ? { ...s, status: 'acquiring' } : s)), 0)
      return () => clearTimeout(t)
    }
  }, [connected, state.status])

  const takeOver = useCallback(() => realtime.acquireLock(imageId, true), [imageId])
  const markDenied = useCallback(
    (holder: UserBrief | null) => setState((s) => (s.imageId === imageId ? { imageId, status: 'denied', holder } : s)),
    [imageId],
  )

  const effective = current ?? { imageId, status: expected, holder: null }
  return { status: effective.status, holder: effective.holder, takeOver, markDenied }
}
