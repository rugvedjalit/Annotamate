import type { StatusCounts } from '@/lib/types'
import { STATUS_META, STATUS_ORDER } from '@/lib/status'
import { formatNumber, formatPercent } from '@/lib/format'
import { cn } from '@/lib/utils'
import { StatusIcon } from '@/components/StatusIcon'
import { Tooltip } from '@/components/ui/Tooltip'
import { statusSegments, totalOf } from './projectUtils'

interface StatusBarProps {
  counts: StatusCounts
  total?: number
  /** thin = 6px (cards), regular = 8px (dashboards) */
  size?: 'thin' | 'regular'
  className?: string
}

/**
 * One whole split into status parts: proportional widths, a 2px surface gap between parts,
 * fully rounded ends, hover/focus tooltips per part and an accessible summary.
 */
export function StatusBar({ counts, total, size = 'regular', className }: StatusBarProps) {
  const sum = total ?? totalOf(counts)
  const segments = statusSegments(counts, sum)
  const summary =
    sum === 0
      ? 'No images'
      : segments.map((s) => `${STATUS_META[s.status].label}: ${formatNumber(s.count)} (${formatPercent(s.count, sum)})`).join(', ')
  return (
    <div
      role="img"
      aria-label={`Status breakdown. ${summary}`}
      className={cn(
        'flex w-full gap-[2px] overflow-hidden rounded-full',
        size === 'thin' ? 'h-1.5' : 'h-2',
        segments.length === 0 && 'bg-hover',
        className,
      )}
    >
      {segments.map((s) => (
        <Tooltip
          key={s.status}
          delayDuration={150}
          content={
            <span className="flex items-center gap-1.5">
              <StatusIcon status={s.status} />
              <span className="font-semibold text-fg">{formatNumber(s.count)}</span>
              <span className="text-muted">
                {STATUS_META[s.status].label} · {formatPercent(s.count, sum, s.share < 1 ? 1 : 0)}
              </span>
            </span>
          }
        >
          <span
            className="h-full min-w-[3px] transition-[filter] hover:brightness-125"
            style={{ width: `${s.share}%`, background: STATUS_META[s.status].color }}
          />
        </Tooltip>
      ))}
    </div>
  )
}

/** Legend for StatusBar: shape icon + label + count, in bar order (identity is never colour-only). */
export function StatusLegend({ counts, className, hideZero }: { counts: StatusCounts; className?: string; hideZero?: boolean }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5', className)}>
      {STATUS_ORDER.filter((s) => !hideZero || counts[s] > 0).map((s) => (
        <li key={s} className="flex items-center gap-1.5 text-sm">
          <StatusIcon status={s} />
          <span className="text-muted">{STATUS_META[s].label}</span>
          <span className="font-medium tabular-nums text-fg">{formatNumber(counts[s] ?? 0)}</span>
        </li>
      ))}
    </ul>
  )
}
