import { NavLink } from 'react-router'
import type { Conversation } from '@/lib/types'
import { relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/Avatar'

interface ConversationListProps {
  conversations: readonly Conversation[]
  meId: number
}

export function ConversationList({ conversations, meId }: ConversationListProps) {
  return (
    <ul className="flex flex-col gap-0.5 p-1.5" aria-label="Conversations">
      {conversations.map((c) => {
        const mine = c.last_message.sender_id === meId
        const unread = c.unread_count > 0
        return (
          <li key={c.user.id}>
            <NavLink
              to={`/messages/${c.user.id}`}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2.5 rounded-md px-2 py-2 transition-colors',
                  isActive ? 'bg-accent-soft' : 'hover:bg-hover',
                )
              }
            >
              <Avatar user={c.user} size="md" showPresence tooltip={false} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className={cn('truncate text-base', unread ? 'font-semibold text-fg' : 'font-medium text-fg')}>
                    {c.user.display_name}
                  </span>
                  <time dateTime={c.last_message.created_at} className="ml-auto shrink-0 text-2xs text-dim">
                    {relativeTime(c.last_message.created_at)}
                  </time>
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn('truncate text-sm', unread ? 'text-fg' : 'text-muted')}>
                    {mine && <span className="text-dim">You: </span>}
                    {c.last_message.body}
                  </span>
                  {unread && (
                    <span
                      className="ml-auto grid h-4 min-w-4 shrink-0 place-items-center rounded-full bg-warn px-1 text-[10px] font-bold text-white"
                      aria-label={`${c.unread_count} unread`}
                    >
                      {c.unread_count > 99 ? '99+' : c.unread_count}
                    </span>
                  )}
                </div>
              </div>
            </NavLink>
          </li>
        )
      })}
    </ul>
  )
}
