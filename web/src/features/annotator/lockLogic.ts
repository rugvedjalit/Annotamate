// Pure rules for reacting to server lock messages about the open image.
import type { UserBrief } from '@/lib/types'
import type { LockStatus } from './useImageLock'

export type LockReaction =
  | { kind: 'none' }
  /** Ask the server for the lock again (status becomes "acquiring"). */
  | { kind: 'reacquire' }
  /** Someone else holds it: read-only. */
  | { kind: 'denied'; holder: UserBrief }

/** `lock.state` for the open image: who holds it now, as seen by a client in `status`. */
export function reactToLockState(status: LockStatus, holder: UserBrief | null, meId: number | undefined): LockReaction {
  if (holder === null) {
    // The holder left (we were waiting), or the lock we thought we held is gone (expired / released): ask again.
    return status === 'denied' || status === 'revoked' || status === 'held' ? { kind: 'reacquire' } : { kind: 'none' }
  }
  if (holder.id === meId) return { kind: 'none' }
  // Someone else holds it while we believed we held it or were still asking.
  return status === 'acquiring' || status === 'unavailable' || status === 'held' ? { kind: 'denied', holder } : { kind: 'none' }
}

/** `lock.expired`: the server swept our lock for inactivity. Only meaningful while we believe we hold it. */
export function reactToLockExpired(status: LockStatus): LockReaction {
  return status === 'held' || status === 'unavailable' ? { kind: 'reacquire' } : { kind: 'none' }
}
