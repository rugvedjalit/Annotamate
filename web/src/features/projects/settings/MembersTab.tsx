import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { LogOut, UserMinus, UserPlus, Users } from 'lucide-react'
import { toast } from 'sonner'
import { removeMember, updateMember } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import type { Member, Project, Role } from '@/lib/types'
import { ROLES } from '@/lib/types'
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/status'
import { formatDate, formatNumber } from '@/lib/format'
import { naturalCompare } from '@/lib/utils'
import { useMembers } from '@/hooks/queries'
import { useSession } from '@/stores/session'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Select } from '@/components/ui/Select'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/ui/Feedback'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { AddMemberDialog } from './AddMemberDialog'

export function MembersTab({ project }: { project: Project }) {
  const pid = project.id
  const qc = useQueryClient()
  const navigate = useNavigate()
  const me = useSession((s) => s.user)
  const members = useMembers(pid)
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<Member | null>(null)

  function refresh() {
    void qc.invalidateQueries({ queryKey: qk.members(pid) })
    void qc.invalidateQueries({ queryKey: qk.project(pid) })
    void qc.invalidateQueries({ queryKey: qk.projectsAll })
  }

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: number; role: Role }) => updateMember(pid, userId, role),
    onMutate: ({ userId, role }) => {
      const prev = qc.getQueryData<Member[]>(qk.members(pid))
      qc.setQueryData<Member[]>(qk.members(pid), (old) => old?.map((m) => (m.user.id === userId ? { ...m, role } : m)))
      return { prev }
    },
    onSuccess: (m) => {
      toast.success(`${m.user.display_name} is now ${ROLE_LABELS[m.role].toLowerCase()}`)
      refresh()
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.members(pid), ctx.prev)
      toast.error('Could not change the role', { description: errorMessage(err) })
    },
  })

  async function remove(m: Member) {
    const self = m.user.id === me?.id
    try {
      await removeMember(pid, m.user.id)
    } catch (err) {
      toast.error(self ? 'Could not leave the project' : 'Could not remove the member', { description: errorMessage(err) })
      throw err
    }
    toast.success(self ? `You left “${project.name}”` : `${m.user.display_name} was removed`, {
      description: self ? undefined : 'Their assignments were cleared.',
    })
    if (self && !me?.is_admin) {
      navigate('/', { replace: true })
      void qc.invalidateQueries({ queryKey: qk.projectsAll })
      return
    }
    refresh()
    void qc.invalidateQueries({ queryKey: qk.imagesAll(pid) })
  }

  const list = [...(members.data ?? [])].sort(
    (a, b) => ROLES.indexOf(b.role) - ROLES.indexOf(a.role) || naturalCompare(a.user.display_name, b.user.display_name),
  )

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel shadow-card">
      <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-md font-semibold text-fg">Members</h2>
          <p className="mt-0.5 text-sm text-muted">Roles decide who can annotate, review and manage this project.</p>
        </div>
        <Button variant="primary" onClick={() => setAdding(true)}>
          <UserPlus />
          Add member
        </Button>
      </header>
      {members.isPending ? (
        <SkeletonRows rows={4} className="p-4" rowClassName="h-10" />
      ) : members.isError ? (
        <ErrorState compact error={members.error} onRetry={() => void members.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState compact icon={<Users />} title="No members yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-5 py-2 font-medium">Person</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 text-right font-medium">Assigned</th>
                <th className="px-3 py-2 text-right font-medium">Done</th>
                <th className="px-3 py-2 font-medium">Joined</th>
                <th className="w-12 px-3 py-2" aria-label="Actions" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((m) => {
                const self = m.user.id === me?.id
                return (
                  <tr key={m.user.id}>
                    <td className="px-5 py-2">
                      <div className="flex items-center gap-2.5">
                        <Avatar user={m.user} size="sm" showPresence />
                        <span className="min-w-0">
                          <span className="block truncate text-base text-fg">
                            {m.user.display_name}
                            {self && <span className="ml-1.5 text-xs text-dim">(you)</span>}
                          </span>
                          <span className="block truncate font-mono text-xs text-dim">@{m.user.username}</span>
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Select
                        aria-label={`Role of ${m.user.display_name}`}
                        size="sm"
                        className="w-36"
                        contentClassName="w-72"
                        value={m.role}
                        disabled={changeRole.isPending}
                        onValueChange={(role) => role !== m.role && changeRole.mutate({ userId: m.user.id, role })}
                        items={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r], textValue: ROLE_LABELS[r], description: ROLE_DESCRIPTIONS[r] }))}
                      />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(m.assigned_count)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatNumber(m.done_count)}</td>
                    <td className="px-3 py-2 text-muted">{formatDate(m.joined_at)}</td>
                    <td className="px-3 py-2 text-right">
                      <IconButton
                        size="sm"
                        variant="danger"
                        label={self ? 'Leave project' : `Remove ${m.user.display_name}`}
                        icon={self ? <LogOut /> : <UserMinus />}
                        onClick={() => setRemoving(m)}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {adding && <AddMemberDialog projectId={pid} members={members.data ?? []} onOpenChange={(o) => !o && setAdding(false)} />}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        danger
        title={removing?.user.id === me?.id ? 'Leave this project?' : `Remove ${removing?.user.display_name ?? ''}?`}
        description={
          removing?.user.id === me?.id
            ? 'You lose access to its images, chat and comments unless someone adds you again.'
            : 'They lose access to the project. Images assigned to them become unassigned; their labels stay.'
        }
        confirmLabel={removing?.user.id === me?.id ? 'Leave project' : 'Remove'}
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </section>
  )
}
