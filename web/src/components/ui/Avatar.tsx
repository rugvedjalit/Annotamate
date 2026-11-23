import type { UserBrief } from '@/lib/types'
import { cn, contrastText, initials } from '@/lib/utils'
import { useIsOnline } from '@/stores/realtime'
import { Tooltip } from './Tooltip'

const sizes = {
  xs: 'size-[18px] text-[8px] border-[1.5px]',
  sm: 'size-6 text-[9.5px] border-2',
  md: 'size-8 text-xs border-2',
  lg: 'size-10 text-sm border-2',
  xl: 'size-16 text-xl border-[3px]',
}

const dotSizes = {
  xs: 'size-1.5 -right-px -bottom-px',
  sm: 'size-2 -right-0.5 -bottom-0.5',
  md: 'size-2.5 -right-0.5 -bottom-0.5',
  lg: 'size-3 right-0 bottom-0',
  xl: 'size-4 right-0.5 bottom-0.5',
}

interface AvatarProps {
  user: Pick<UserBrief, 'display_name' | 'avatar_color'> & { id?: number }
  size?: keyof typeof sizes
  /** Show the online dot (uses live presence). */
  showPresence?: boolean
  /** Tooltip text (defaults to the display name); false disables it. */
  tooltip?: string | false
  className?: string
}

export function Avatar({ user, size = 'sm', showPresence, tooltip, className }: AvatarProps) {
  const online = useIsOnline(showPresence ? user.id : null)
  const el = (
    <span
      className={cn(
        'relative inline-grid shrink-0 select-none place-items-center rounded-full border-panel font-bold leading-none',
        sizes[size],
        className,
      )}
      style={{ background: user.avatar_color, color: contrastText(user.avatar_color) }}
      role="img"
      aria-label={user.display_name + (showPresence ? (online ? ' (online)' : ' (offline)') : '')}
    >
      {initials(user.display_name)}
      {showPresence && (
        <span
          className={cn(
            'absolute rounded-full ring-2 ring-panel',
            dotSizes[size],
            online ? 'bg-ok' : 'bg-line-strong',
          )}
          aria-hidden
        />
      )}
    </span>
  )
  if (tooltip === false) return el
  return <Tooltip content={tooltip ?? user.display_name}>{el}</Tooltip>
}

interface AvatarStackProps {
  users: readonly UserBrief[]
  max?: number
  size?: keyof typeof sizes
  className?: string
  /** Per-user tooltip text. */
  describe?: (u: UserBrief) => string
  /** Total number of people when `users` is only a preview (the "+N" counts the rest). */
  total?: number
}

export function AvatarStack({ users, max = 4, size = 'sm', className, describe, total }: AvatarStackProps) {
  if (users.length === 0) return null
  const shown = users.slice(0, max)
  const rest = Math.max(total ?? users.length, users.length) - shown.length
  const hiddenNames = users.slice(max).map((u) => u.display_name)
  const unnamed = rest - hiddenNames.length
  const overlap = size === 'xs' ? '-ml-[3px]' : size === 'sm' ? '-ml-[5px]' : '-ml-1.5'
  return (
    <div className={cn('flex items-center', className)}>
      {shown.map((u, i) => (
        <Avatar
          key={u.id}
          user={u}
          size={size}
          tooltip={describe ? describe(u) : u.display_name}
          className={i > 0 ? overlap : undefined}
        />
      ))}
      {rest > 0 && (
        <Tooltip content={unnamed > 0 ? [...hiddenNames, `${unnamed} more`].join(', ') : hiddenNames.join(', ')}>
          <span
            className={cn(
              'inline-grid place-items-center rounded-full border-panel bg-hover font-semibold text-muted',
              sizes[size],
              overlap,
            )}
          >
            +{rest}
          </span>
        </Tooltip>
      )}
    </div>
  )
}
