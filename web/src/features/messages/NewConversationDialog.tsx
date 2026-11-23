import { useNavigate } from 'react-router'
import { Command } from 'cmdk'
import { Search, UserRoundX } from 'lucide-react'
import { useUsers } from '@/hooks/queries'
import { relativeTime } from '@/lib/format'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { Avatar } from '@/components/ui/Avatar'
import { ErrorState, SkeletonRows } from '@/components/ui/Feedback'

interface NewConversationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  meId: number
}

/** Pick any active user to start (or continue) a direct conversation. */
export function NewConversationDialog({ open, onOpenChange, meId }: NewConversationDialogProps) {
  const navigate = useNavigate()
  const users = useUsers(false, open)
  const people = (users.data ?? []).filter((u) => u.id !== meId && u.is_active)

  function pick(id: number) {
    onOpenChange(false)
    navigate(`/messages/${id}`)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" title="New message" description="Choose who you want to write to." bodyClassName="p-0">
        <Command loop className="flex flex-col">
          <div className="flex items-center gap-2 border-b border-line px-4">
            <Search className="size-4 text-dim" aria-hidden />
            <Command.Input
              autoFocus
              placeholder="Search people…"
              className="h-11 flex-1 bg-transparent text-base text-fg placeholder:text-dim focus:outline-none"
            />
          </div>
          <Command.List className="max-h-[360px] overflow-y-auto p-1.5">
            {users.isPending ? (
              <SkeletonRows rows={5} className="p-2" rowClassName="h-9" />
            ) : users.isError ? (
              <ErrorState compact error={users.error} onRetry={() => void users.refetch()} />
            ) : (
              <>
                <Command.Empty className="flex flex-col items-center gap-1.5 px-4 py-8 text-center text-sm text-muted">
                  <UserRoundX className="size-4 text-dim" aria-hidden />
                  {people.length === 0 ? 'There is nobody else on this server yet.' : 'No one matches your search.'}
                </Command.Empty>
                {people.map((u) => (
                  <Command.Item
                    key={u.id}
                    value={`${u.display_name} ${u.username}`}
                    onSelect={() => pick(u.id)}
                    className="flex h-11 cursor-pointer items-center gap-2.5 rounded-md px-2 text-base data-[selected=true]:bg-hover"
                  >
                    <Avatar user={u} size="sm" showPresence tooltip={false} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-fg">{u.display_name}</div>
                      <div className="truncate font-mono text-2xs text-dim">@{u.username}</div>
                    </div>
                    <span className="shrink-0 text-2xs text-dim">
                      {u.online ? 'Online' : u.last_seen_at ? `Seen ${relativeTime(u.last_seen_at)}` : ''}
                    </span>
                  </Command.Item>
                ))}
              </>
            )}
          </Command.List>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
