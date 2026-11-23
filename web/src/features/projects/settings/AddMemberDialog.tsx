import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { addMember } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import type { Member, Role } from '@/lib/types'
import { ROLES } from '@/lib/types'
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/status'
import { cn } from '@/lib/utils'
import { useUsers } from '@/hooks/queries'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Avatar } from '@/components/ui/Avatar'
import { ErrorState, SkeletonRows } from '@/components/ui/Feedback'

interface AddMemberDialogProps {
  projectId: number
  members: Member[]
  onOpenChange: (open: boolean) => void
}

export function AddMemberDialog({ projectId, members, onOpenChange }: AddMemberDialogProps) {
  const qc = useQueryClient()
  const users = useUsers(false)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<number | null>(null)
  const [role, setRole] = useState<Role>('annotator')

  const candidates = useMemo(() => {
    const memberIds = new Set(members.map((m) => m.user.id))
    const q = query.trim().toLowerCase()
    return (users.data ?? [])
      .filter((u) => !memberIds.has(u.id))
      .filter((u) => !q || u.display_name.toLowerCase().includes(q) || u.username.includes(q))
  }, [users.data, members, query])
  const pickedUser = users.data?.find((u) => u.id === picked)

  const add = useMutation({
    mutationFn: (userId: number) => addMember(projectId, userId, role),
    onSuccess: (m) => {
      toast.success(`${m.user.display_name} joined as ${ROLE_LABELS[m.role]}`)
      void qc.invalidateQueries({ queryKey: qk.members(projectId) })
      void qc.invalidateQueries({ queryKey: qk.project(projectId) })
      void qc.invalidateQueries({ queryKey: qk.projectsAll })
      onOpenChange(false)
    },
    onError: (err) => toast.error('Could not add the member', { description: errorMessage(err) }),
  })

  return (
    <Dialog open onOpenChange={(o) => !add.isPending && onOpenChange(o)}>
      <DialogContent
        size="md"
        title="Add a member"
        description="They are notified and the project appears on their projects page."
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={add.isPending}>
              Cancel
            </Button>
            <Button variant="primary" disabled={picked === null} loading={add.isPending} onClick={() => picked !== null && add.mutate(picked)}>
              {!add.isPending && <UserPlus />}
              {pickedUser ? `Add ${pickedUser.display_name}` : 'Add member'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Input
            aria-label="Search people"
            leftIcon={<Search />}
            placeholder="Search by name or username"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="h-64 overflow-y-auto rounded-lg border border-line" role="listbox" aria-label="People">
            {users.isPending ? (
              <SkeletonRows rows={5} className="p-2" rowClassName="h-10" />
            ) : users.isError ? (
              <ErrorState compact error={users.error} onRetry={() => void users.refetch()} />
            ) : candidates.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted">
                {query ? 'Nobody matches this search.' : 'Everyone is already a member of this project.'}
              </p>
            ) : (
              candidates.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  role="option"
                  aria-selected={picked === u.id}
                  onClick={() => setPicked(u.id)}
                  onDoubleClick={() => {
                    setPicked(u.id)
                    add.mutate(u.id)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2.5 border-b border-line/60 px-3 py-2 text-left last:border-b-0 hover:bg-hover',
                    picked === u.id && 'bg-accent-soft hover:bg-accent-soft',
                  )}
                >
                  <Avatar user={u} size="sm" showPresence tooltip={false} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base text-fg">{u.display_name}</span>
                    <span className="block truncate font-mono text-xs text-dim">@{u.username}</span>
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium">Role</span>
            <Select
              aria-label="Role"
              className="w-72"
              value={role}
              onValueChange={setRole}
              items={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r], description: ROLE_DESCRIPTIONS[r] }))}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
