import { Link } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import type { Member } from '@/lib/types'
import { ROLE_LABELS } from '@/lib/status'
import { findCachedImage } from '@/lib/cacheUpdates'
import { naturalCompare } from '@/lib/utils'
import { formatDateTime, relativeTime } from '@/lib/format'
import { useRealtime } from '@/stores/realtime'
import { Avatar } from '@/components/ui/Avatar'
import { EmptyState } from '@/components/ui/Feedback'

/** Members with live presence: online first, with the image each person is on. */
export function MembersPresence({ projectId, members }: { projectId: number; members: Member[] }) {
  const qc = useQueryClient()
  const online = useRealtime((s) => s.onlineUserIds)
  const presence = useRealtime((s) => (s.presenceProjectId === projectId ? s.presence : null))

  if (members.length === 0) return <EmptyState compact icon={<Users />} title="No members yet" />

  const sorted = [...members].sort((a, b) => {
    const pa = presence?.[a.user.id] ? 2 : online.has(a.user.id) ? 1 : 0
    const pb = presence?.[b.user.id] ? 2 : online.has(b.user.id) ? 1 : 0
    return pb - pa || naturalCompare(a.user.display_name, b.user.display_name)
  })

  return (
    <ul className="-my-1 flex flex-col">
      {sorted.map((m) => {
        const here = presence?.[m.user.id]
        const isOnline = online.has(m.user.id) || !!here
        const filename =
          here?.imageId != null ? (here.imageFilename ?? findCachedImage(qc, projectId, here.imageId)?.filename) : undefined
        return (
          <li key={m.user.id} className="flex items-center gap-2.5 py-1.5">
            <Avatar user={m.user} size="sm" showPresence />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="truncate text-base text-fg">{m.user.display_name}</span>
                <span className="shrink-0 text-xs text-dim">{ROLE_LABELS[m.role]}</span>
              </div>
              <div className="truncate text-xs text-muted">
                {here?.imageId != null ? (
                  <>
                    On{' '}
                    <Link to={`/p/${projectId}/annotate/${here.imageId}`} className="font-mono text-fg hover:text-accent-text hover:underline">
                      {filename ?? `image #${here.imageId}`}
                    </Link>
                  </>
                ) : here ? (
                  'In this project'
                ) : isOnline ? (
                  'Online'
                ) : (
                  <span className="text-dim" title={m.last_seen_at ? formatDateTime(m.last_seen_at) : undefined}>
                    {m.last_seen_at ? `Last seen ${relativeTime(m.last_seen_at)}` : 'Never signed in'}
                  </span>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
