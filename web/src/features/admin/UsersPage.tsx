import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import {
  Ellipsis,
  KeyRound,
  MessagesSquare,
  Pencil,
  Search,
  ShieldCheck,
  ShieldOff,
  UserCheck,
  UserPlus,
  UserX,
  Users,
} from 'lucide-react'
import type { UserWithPresence } from '@/lib/types'
import { formatDate, formatDateTime, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useUsers } from '@/hooks/queries'
import { useMe } from '@/stores/session'
import { useIsOnline, useRealtime } from '@/stores/realtime'
import { generatePassword } from '@/features/auth/validation'
import { Avatar } from '@/components/ui/Avatar'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { Label } from '@/components/ui/Field'
import { EmptyState, ErrorState, SkeletonRows } from '@/components/ui/Feedback'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { iconButtonVariants } from '@/components/ui/variants'
import { Tooltip } from '@/components/ui/Tooltip'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { CreateUserDialog } from './CreateUserDialog'
import { EditUserDialog } from './EditUserDialog'
import { ResetPasswordDialog } from './ResetPasswordDialog'
import { useUpdateUser } from './useUserMutations'

type Confirm =
  | { kind: 'deactivate' | 'reactivate' | 'make-admin' | 'remove-admin'; user: UserWithPresence }
  | null

/** Administration: every account on the server. */
export function UsersPage() {
  const me = useMe()
  const [showInactive, setShowInactive] = useState(false)
  const users = useUsers(showInactive)
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<UserWithPresence | null>(null)
  const [resetting, setResetting] = useState<{ user: UserWithPresence; initial: string } | null>(null)
  const [confirm, setConfirm] = useState<Confirm>(null)
  const update = useUpdateUser()

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = users.data ?? []
    if (!q) return list
    return list.filter(
      (u) =>
        u.display_name.toLowerCase().includes(q) ||
        u.username.includes(q) ||
        (u.email ?? '').toLowerCase().includes(q),
    )
  }, [users.data, search])

  const counts = useMemo(() => {
    const list = users.data ?? []
    return {
      total: list.filter((u) => u.is_active).length,
      admins: list.filter((u) => u.is_admin && u.is_active).length,
    }
  }, [users.data])

  function runConfirm() {
    if (!confirm) return
    const u = confirm.user
    const map = {
      deactivate: { body: { is_active: false }, success: `${u.display_name} was deactivated and signed out` },
      reactivate: { body: { is_active: true }, success: `${u.display_name} can sign in again` },
      'make-admin': { body: { is_admin: true }, success: `${u.display_name} is now an administrator` },
      'remove-admin': { body: { is_admin: false }, success: `${u.display_name} is no longer an administrator` },
    } as const
    const { body, success } = map[confirm.kind]
    return update.mutateAsync({ id: u.id, body, success })
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Users</h1>
          <p className="text-sm text-muted">
            {users.data
              ? `${counts.total} active ${counts.total === 1 ? 'account' : 'accounts'} · ${counts.admins} ${counts.admins === 1 ? 'administrator' : 'administrators'}`
              : 'Accounts on this Annotamate server.'}
          </p>
        </div>
        <Button variant="primary" className="ml-auto" onClick={() => setCreateOpen(true)}>
          <UserPlus />
          Create user
        </Button>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Input
          wrapperClassName="w-72"
          leftIcon={<Search />}
          placeholder="Search name, username or email"
          aria-label="Search users"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="ml-auto flex items-center gap-2">
          <Switch id="show-inactive" checked={showInactive} onCheckedChange={setShowInactive} />
          <Label htmlFor="show-inactive" className="cursor-pointer font-normal text-muted">
            Show deactivated
          </Label>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-panel shadow-card">
        {users.isPending ? (
          <SkeletonRows rows={6} className="p-4" rowClassName="h-11" />
        ) : users.isError ? (
          <ErrorState error={users.error} onRetry={() => void users.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Users />}
            title={search ? 'No matching users' : 'No users yet'}
            description={search ? 'Try a different search.' : 'Create accounts for your team to get started.'}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-base">
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th scope="col" className="px-4 py-2.5 font-medium">User</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Email</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Role</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Last seen</th>
                  <th scope="col" className="px-3 py-2.5 font-medium">Created</th>
                  <th scope="col" className="w-12 px-3 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    isSelf={u.id === me.id}
                    onEdit={() => setEditing(u)}
                    onReset={() => setResetting({ user: u, initial: generatePassword() })}
                    onConfirm={(kind) => setConfirm({ kind, user: u })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditUserDialog user={editing} isSelf={editing?.id === me.id} onOpenChange={(o) => !o && setEditing(null)} />
      <ResetPasswordDialog target={resetting} onOpenChange={(o) => !o && setResetting(null)} />
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        danger={confirm?.kind === 'deactivate' || confirm?.kind === 'remove-admin'}
        title={
          confirm?.kind === 'deactivate'
            ? `Deactivate ${confirm.user.display_name}?`
            : confirm?.kind === 'reactivate'
              ? `Reactivate ${confirm.user.display_name}?`
              : confirm?.kind === 'make-admin'
                ? `Make ${confirm.user.display_name} an administrator?`
                : `Remove administrator rights from ${confirm?.user.display_name ?? ''}?`
        }
        description={
          confirm?.kind === 'deactivate'
            ? 'They are signed out immediately and cannot sign in until reactivated. Their annotations, messages and history are kept.'
            : confirm?.kind === 'reactivate'
              ? 'They will be able to sign in again with their existing password.'
              : confirm?.kind === 'make-admin'
                ? 'Administrators can manage every account and create or delete any project.'
                : 'They keep their project roles but can no longer manage users or create projects.'
        }
        confirmLabel={
          confirm?.kind === 'deactivate'
            ? 'Deactivate'
            : confirm?.kind === 'reactivate'
              ? 'Reactivate'
              : confirm?.kind === 'make-admin'
                ? 'Make administrator'
                : 'Remove rights'
        }
        onConfirm={runConfirm}
      />
    </div>
  )
}

interface UserRowProps {
  user: UserWithPresence
  isSelf: boolean
  onEdit: () => void
  onReset: () => void
  onConfirm: (kind: NonNullable<Confirm>['kind']) => void
}

function UserRow({ user: u, isSelf, onEdit, onReset, onConfirm }: UserRowProps) {
  const navigate = useNavigate()
  const live = useIsOnline(u.id)
  const connected = useRealtime((s) => s.everConnected)
  // Live presence once the socket is up; the list's snapshot before that.
  const online = connected ? live : u.online
  return (
    <tr className={cn('transition-colors hover:bg-hover/50', !u.is_active && 'opacity-60')}>
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <Avatar user={u} size="md" showPresence={u.is_active} tooltip={false} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 truncate font-medium text-fg">
              {u.display_name}
              {isSelf && <span className="text-xs font-normal text-dim">(you)</span>}
            </div>
            <div className="truncate font-mono text-xs text-dim">@{u.username}</div>
          </div>
        </div>
      </td>
      <td className="max-w-[220px] truncate px-3 py-2.5 text-muted">{u.email ?? <span className="text-dim">—</span>}</td>
      <td className="px-3 py-2.5">
        {u.is_admin ? (
          <Badge variant="accent">
            <ShieldCheck aria-hidden />
            Admin
          </Badge>
        ) : (
          <span className="text-sm text-muted">Member</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        {u.is_active ? <Badge variant="ok">Active</Badge> : <Badge variant="neutral">Deactivated</Badge>}
      </td>
      <td className="px-3 py-2.5 text-sm">
        {online && u.is_active ? (
          <span className="inline-flex items-center gap-1.5 text-ok">
            <span className="size-1.5 rounded-full bg-ok" aria-hidden />
            Online
          </span>
        ) : u.last_seen_at ? (
          <span className="text-muted" title={formatDateTime(u.last_seen_at)}>
            {relativeTime(u.last_seen_at)}
          </span>
        ) : (
          <span className="text-dim">Never</span>
        )}
      </td>
      <td className="px-3 py-2.5 text-sm text-muted" title={formatDateTime(u.created_at)}>
        {formatDate(u.created_at)}
      </td>
      <td className="px-3 py-2.5">
        <DropdownMenu>
          <Tooltip content="Actions">
            <DropdownMenuTrigger className={cn(iconButtonVariants({ size: 'sm' }))} aria-label={`Actions for ${u.display_name}`}>
              <Ellipsis />
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem icon={<Pencil />} onSelect={onEdit}>
              Edit details
            </DropdownMenuItem>
            <DropdownMenuItem icon={<KeyRound />} onSelect={onReset}>
              Reset password
            </DropdownMenuItem>
            {!isSelf && u.is_active && (
              <DropdownMenuItem icon={<MessagesSquare />} onSelect={() => navigate(`/messages/${u.id}`)}>
                Send a message
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {u.is_admin ? (
              <DropdownMenuItem icon={<ShieldOff />} disabled={isSelf} onSelect={() => onConfirm('remove-admin')}>
                Remove administrator
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem icon={<ShieldCheck />} disabled={!u.is_active} onSelect={() => onConfirm('make-admin')}>
                Make administrator
              </DropdownMenuItem>
            )}
            {u.is_active ? (
              <DropdownMenuItem icon={<UserX />} danger disabled={isSelf} onSelect={() => onConfirm('deactivate')}>
                Deactivate
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem icon={<UserCheck />} onSelect={() => onConfirm('reactivate')}>
                Reactivate
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  )
}
