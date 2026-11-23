import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Search, SquarePen, UserRoundX } from 'lucide-react'
import { useConversations, useUsers } from '@/hooks/queries'
import { useMe } from '@/stores/session'
import { Logo } from '@/components/brand/Logo'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/ui/Feedback'
import { ConversationList } from './ConversationList'
import { DirectThread } from './DirectThread'
import { NewConversationDialog } from './NewConversationDialog'

/** Direct messages: conversation list on the left, the selected thread on the right. */
export function MessagesPage() {
  const me = useMe()
  const params = useParams()
  const userId = params.userId && /^\d+$/.test(params.userId) ? Number(params.userId) : null
  const conversations = useConversations()
  const users = useUsers(false)
  const [search, setSearch] = useState('')
  const [newOpen, setNewOpen] = useState(false)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = conversations.data ?? []
    if (!q) return list
    return list.filter((c) => c.user.display_name.toLowerCase().includes(q) || c.user.username.includes(q))
  }, [conversations.data, search])

  const mentionUsers = useMemo(() => (users.data ?? []).filter((u) => u.id !== me.id), [users.data, me.id])

  const selectedUser = useMemo(() => {
    if (userId === null) return null
    const fromUsers = users.data?.find((u) => u.id === userId)
    if (fromUsers) return fromUsers
    return conversations.data?.find((c) => c.user.id === userId)?.user ?? null
  }, [userId, users.data, conversations.data])
  const lastSeenAt = users.data?.find((u) => u.id === userId)?.last_seen_at ?? null
  const resolving = userId !== null && !selectedUser && (users.isPending || conversations.isPending)

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-line bg-panel" aria-label="Direct messages">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
          <h1 className="text-md font-semibold">Messages</h1>
          <IconButton
            className="ml-auto"
            label="New message"
            icon={<SquarePen />}
            variant="outline"
            onClick={() => setNewOpen(true)}
          />
        </div>
        <div className="p-3 pb-1">
          <Input
            size="sm"
            leftIcon={<Search />}
            placeholder="Search conversations"
            aria-label="Search conversations"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {conversations.isPending ? (
            <SkeletonRows rows={6} className="p-3" rowClassName="h-11" />
          ) : conversations.isError ? (
            <ErrorState compact error={conversations.error} onRetry={() => void conversations.refetch()} />
          ) : filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted">
              {search ? 'No conversations match your search.' : 'No conversations yet.'}
              {!search && (
                <Button size="sm" variant="secondary" className="mt-3" onClick={() => setNewOpen(true)}>
                  <SquarePen />
                  Start a conversation
                </Button>
              )}
            </div>
          ) : (
            <ConversationList conversations={filtered} meId={me.id} />
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 bg-bg">
        {userId === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
            <Logo variant="mark" height={56} className="opacity-90" />
            <h2 className="text-md font-semibold">Your direct messages</h2>
            <p className="max-w-sm text-sm text-muted">
              Pick a conversation on the left, or start a new one with anyone on this server.
            </p>
            <Button variant="primary" onClick={() => setNewOpen(true)}>
              <SquarePen />
              New message
            </Button>
          </div>
        ) : userId === me.id ? (
          <EmptyState
            className="flex-1"
            icon={<UserRoundX />}
            title="That's you"
            description="You cannot send direct messages to yourself."
            action={
              <Button asChild variant="secondary">
                <Link to="/messages">Back to messages</Link>
              </Button>
            }
          />
        ) : selectedUser ? (
          <DirectThread
            key={selectedUser.id}
            me={me}
            other={selectedUser}
            lastSeenAt={lastSeenAt}
            mentionUsers={mentionUsers}
          />
        ) : resolving ? (
          <SkeletonRows rows={4} className="flex-1 p-6" rowClassName="h-10" />
        ) : users.isError ? (
          <ErrorState className="flex-1" error={users.error} onRetry={() => void users.refetch()} />
        ) : (
          <EmptyState
            className="flex-1"
            icon={<UserRoundX />}
            title="Person not found"
            description="This account may have been deactivated."
            action={
              <Button asChild variant="secondary">
                <Link to="/messages">Back to messages</Link>
              </Button>
            }
          />
        )}
      </div>

      <NewConversationDialog open={newOpen} onOpenChange={setNewOpen} meId={me.id} />
    </div>
  )
}
