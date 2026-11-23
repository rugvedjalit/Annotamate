import { Users } from 'lucide-react'
import type { Member, ProjectStats, Role, UserBrief } from '@/lib/types'
import { ROLE_LABELS } from '@/lib/status'
import { formatNumber } from '@/lib/format'
import { naturalCompare } from '@/lib/utils'
import { Avatar } from '@/components/ui/Avatar'
import { EmptyState } from '@/components/ui/Feedback'

interface Row {
  user: UserBrief
  role: Role | null
  assigned: number
  done: number
  saves: number
  boxes: number
  submitted: number
  approved: number
  rejected: number
}

const num = 'px-3 py-2 text-right tabular-nums'

/** Per-member progress: assignment/done counts from members, work counts from stats. */
export function MemberProgress({ members, stats }: { members: Member[]; stats: ProjectStats }) {
  const perUser = new Map(stats.per_user.map((u) => [u.user.id, u]))
  const rows: Row[] = members.map((m) => {
    const s = perUser.get(m.user.id)
    return {
      user: m.user,
      role: m.role,
      assigned: m.assigned_count,
      done: m.done_count,
      saves: s?.saves ?? 0,
      boxes: s?.boxes ?? 0,
      submitted: s?.submitted ?? 0,
      approved: s?.approved ?? 0,
      rejected: s?.rejected ?? 0,
    }
  })
  // People who worked here but are no longer members (or admins acting as managers).
  for (const s of stats.per_user) {
    if (!members.some((m) => m.user.id === s.user.id)) {
      rows.push({ user: s.user, role: null, assigned: 0, done: 0, saves: s.saves, boxes: s.boxes, submitted: s.submitted, approved: s.approved, rejected: s.rejected })
    }
  }
  rows.sort((a, b) => b.boxes - a.boxes || b.done - a.done || naturalCompare(a.user.display_name, b.user.display_name))

  const maxDone = Math.max(0, ...rows.map((r) => r.done))

  if (rows.length === 0) {
    return <EmptyState compact icon={<Users />} title="No members yet" />
  }

  return (
    <div className="-mx-4 -mb-4 overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th className="px-4 py-2 font-medium">Member</th>
            <th className={`${num} font-medium`}>Assigned</th>
            <th className="px-3 py-2 font-medium" title="Images they finished (done, or submitted and waiting for review)">
              Completed
            </th>
            <th className={`${num} font-medium`}>Saves</th>
            <th className={`${num} font-medium`}>Boxes</th>
            <th className={`${num} font-medium`}>Submitted</th>
            <th className={`${num} font-medium`}>Approved</th>
            <th className={`${num} pr-4 font-medium`}>Rejected</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => {
            // Bar relative to the most productive member (a leaderboard, not a ratio of unrelated sets).
            const share = maxDone > 0 ? (r.done / maxDone) * 100 : 0
            return (
              <tr key={r.user.id} className="hover:bg-hover/60">
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2.5">
                    <Avatar user={r.user} size="sm" showPresence />
                    <span className="min-w-0">
                      <span className="block truncate text-fg">{r.user.display_name}</span>
                      <span className="block text-xs text-dim">{r.role ? ROLE_LABELS[r.role] : 'Not a member'}</span>
                    </span>
                  </div>
                </td>
                <td className={num}>{formatNumber(r.assigned)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="w-10 text-right tabular-nums text-fg">{formatNumber(r.done)}</span>
                    {maxDone > 0 && (
                      <span
                        className="h-1 w-14 overflow-hidden rounded-full bg-ok-soft"
                        title={`${formatNumber(r.done)} ${r.done === 1 ? 'image' : 'images'} finished (done or waiting for review)`}
                      >
                        <span className="block h-full rounded-full bg-st-done" style={{ width: `${share}%` }} />
                      </span>
                    )}
                  </div>
                </td>
                <td className={num}>{formatNumber(r.saves)}</td>
                <td className={num}>{formatNumber(r.boxes)}</td>
                <td className={num}>{formatNumber(r.submitted)}</td>
                <td className={num}>
                  {r.approved > 0 ? <span className="font-medium text-ok">{formatNumber(r.approved)}</span> : <span className="text-dim">0</span>}
                </td>
                <td className={`${num} pr-4`}>
                  {r.rejected > 0 ? <span className="font-medium text-danger">{formatNumber(r.rejected)}</span> : <span className="text-dim">0</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
