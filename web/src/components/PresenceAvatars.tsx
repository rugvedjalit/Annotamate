import { useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { UserBrief } from '@/lib/types'
import { findCachedImage } from '@/lib/cacheUpdates'
import { useRealtime } from '@/stores/realtime'
import { useSession } from '@/stores/session'
import { AvatarStack } from '@/components/ui/Avatar'

interface PresenceAvatarsProps {
  projectId: number
  /** Only people on this image (files panel rows); undefined = everyone in the project. */
  imageId?: number
  size?: 'xs' | 'sm'
  max?: number
  includeMe?: boolean
  className?: string
}

/** Who is in the project (or on an image) right now, from live presence. */
export function PresenceAvatars({ projectId, imageId, size = 'sm', max = 4, includeMe, className }: PresenceAvatarsProps) {
  const qc = useQueryClient()
  const meId = useSession((s) => s.user?.id)
  const presence = useRealtime((s) => (s.presenceProjectId === projectId ? s.presence : null))
  const entries = useMemo(
    () =>
      Object.values(presence ?? {}).filter(
        (p) => (includeMe || p.user.id !== meId) && (imageId === undefined || p.imageId === imageId),
      ),
    [presence, includeMe, meId, imageId],
  )
  const users: UserBrief[] = entries.map((e) => e.user)
  const where = new Map(entries.map((e) => [e.user.id, e]))

  return (
    <AvatarStack
      users={users}
      size={size}
      max={max}
      className={className}
      describe={(u) => {
        const entry = where.get(u.id)
        if (!entry || entry.imageId == null) return `${u.display_name} · in this project`
        const name = entry.imageFilename ?? findCachedImage(qc, projectId, entry.imageId)?.filename ?? `image #${entry.imageId}`
        return `${u.display_name} · on ${name}`
      }}
    />
  )
}
