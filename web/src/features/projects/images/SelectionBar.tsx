import { CircleDot, Flag, FlagOff, Hand, Shuffle, UserMinus, UserPlus, X } from 'lucide-react'
import type { BulkBody, ImageStatus, Member } from '@/lib/types'
import { IMAGE_STATUSES } from '@/lib/types'
import { formatNumber } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { Avatar } from '@/components/ui/Avatar'
import { StatusIcon } from '@/components/StatusIcon'
import { STATUS_META } from '@/lib/status'

interface SelectionBarProps {
  count: number
  total: number | undefined
  allMatching: boolean
  /** Every loaded row is selected but more rows match: offer "select all matching". */
  canSelectAllMatching: boolean
  onSelectAllMatching: () => void
  onClear: () => void
  canManage: boolean
  members: Member[]
  busy: boolean
  onBulk: (body: Omit<BulkBody, 'image_ids' | 'filter'>, label: string) => void
  onDistribute: () => void
  /** Annotators: claim the selected unassigned images. */
  claimable: number
  onClaim?: () => void
}

/** Shown when rows are selected: count, select-all-matching and the bulk actions. */
export function SelectionBar({
  count,
  total,
  allMatching,
  canSelectAllMatching,
  onSelectAllMatching,
  onClear,
  canManage,
  members,
  busy,
  onBulk,
  onDistribute,
  claimable,
  onClaim,
}: SelectionBarProps) {
  const assignable = members.filter((m) => m.role !== 'viewer')
  return (
    <div
      role="toolbar"
      aria-label="Selected images"
      className="flex min-h-11 animate-slide-down flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft px-3 py-1.5"
    >
      <span className="text-sm font-medium text-fg">
        {allMatching ? `All ${formatNumber(total ?? count)} matching images selected` : `${formatNumber(count)} selected`}
      </span>
      {canSelectAllMatching && total !== undefined && (
        <Button variant="link" size="sm" onClick={onSelectAllMatching}>
          Select all {formatNumber(total)} matching
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onClear}>
        <X />
        Clear
      </Button>
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        {canManage ? (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" disabled={busy}>
                  <UserPlus />
                  Assign to…
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-80 w-60 overflow-y-auto">
                <DropdownMenuLabel>Assign to</DropdownMenuLabel>
                {assignable.length === 0 && <div className="px-2 py-2 text-sm text-muted">No members can annotate.</div>}
                {assignable.map((m) => (
                  <DropdownMenuItem
                    key={m.user.id}
                    icon={<Avatar user={m.user} size="xs" tooltip={false} />}
                    onSelect={() => onBulk({ action: 'assign', assignee_id: m.user.id }, `Assigned to ${m.user.display_name}`)}
                  >
                    {m.user.display_name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" disabled={busy} onClick={() => onBulk({ action: 'unassign' }, 'Unassigned')}>
              <UserMinus />
              Unassign
            </Button>
            <Button size="sm" disabled={busy} onClick={onDistribute}>
              <Shuffle />
              Distribute…
            </Button>
            <Button size="sm" disabled={busy} onClick={() => onBulk({ action: 'flag' }, 'Flagged')}>
              <Flag />
              Flag
            </Button>
            <Button size="sm" disabled={busy} onClick={() => onBulk({ action: 'unflag' }, 'Flags removed')}>
              <FlagOff />
              Unflag
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" disabled={busy}>
                  <CircleDot />
                  Set status…
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Set status</DropdownMenuLabel>
                {IMAGE_STATUSES.map((s: ImageStatus) => (
                  <DropdownMenuItem
                    key={s}
                    icon={<StatusIcon status={s} />}
                    onSelect={() => onBulk({ action: 'set_status', status: s }, `Status set to ${STATUS_META[s].label}`)}
                  >
                    {STATUS_META[s].label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : onClaim ? (
          <Button size="sm" variant="primary" disabled={busy || claimable === 0} loading={busy} onClick={onClaim}>
            <Hand />
            {claimable === 0 ? 'Nothing to claim' : `Claim ${formatNumber(claimable)}`}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
