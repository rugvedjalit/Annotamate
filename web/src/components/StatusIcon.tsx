import { Circle, CircleCheck, CircleDot, CircleMinus, CircleX, Clock } from 'lucide-react'
import type { ImageStatus } from '@/lib/types'
import { STATUS_META } from '@/lib/status'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/Badge'

const ICONS = {
  todo: Circle,
  in_progress: CircleDot,
  review: Clock,
  done: CircleCheck,
  rejected: CircleX,
} as const

interface StatusIconProps {
  status: ImageStatus
  /** Done with zero boxes = a "background" image (distinct icon). */
  boxCount?: number
  className?: string
}

/** Status icon: shape + colour + accessible label (colour is never the only signal). */
export function StatusIcon({ status, boxCount, className }: StatusIconProps) {
  const background = status === 'done' && boxCount === 0
  const Icon = background ? CircleMinus : ICONS[status]
  const label = background ? 'Done (no objects)' : STATUS_META[status].label
  return (
    <Icon
      className={cn('size-3.5 shrink-0', STATUS_META[status].text, className)}
      aria-label={label}
      role="img"
      strokeWidth={2.2}
    >
      <title>{label}</title>
    </Icon>
  )
}

const BADGE_VARIANT = {
  todo: 'neutral',
  in_progress: 'accent',
  review: 'warn',
  done: 'ok',
  rejected: 'danger',
} as const

export function StatusBadge({ status, className, size }: { status: ImageStatus; className?: string; size?: 'sm' | 'md' }) {
  const Icon = ICONS[status]
  return (
    <Badge variant={BADGE_VARIANT[status]} size={size} className={className}>
      <Icon aria-hidden strokeWidth={2.4} />
      {STATUS_META[status].label}
    </Badge>
  )
}
