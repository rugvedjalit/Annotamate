import type { ComponentProps, ReactNode } from 'react'
import type { VariantProps } from 'class-variance-authority'
import { iconButtonVariants } from './variants'
import { cn } from '@/lib/utils'
import { Tooltip } from './Tooltip'

export interface IconButtonProps
  extends Omit<ComponentProps<'button'>, 'children'>,
    VariantProps<typeof iconButtonVariants> {
  /** Accessible name; also the tooltip text. */
  label: string
  icon: ReactNode
  shortcut?: string | readonly string[]
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  /** Hide the tooltip (e.g. when wrapped by a menu trigger that has its own). */
  noTooltip?: boolean
  badge?: ReactNode
}

export function IconButton({
  label,
  icon,
  shortcut,
  tooltipSide,
  noTooltip,
  className,
  variant,
  size,
  active,
  badge,
  type,
  ...props
}: IconButtonProps) {
  const button = (
    <button
      type={type ?? 'button'}
      aria-label={label}
      aria-pressed={active === null || active === undefined ? undefined : active}
      className={cn(iconButtonVariants({ variant, size, active }), className)}
      {...props}
    >
      {icon}
      {badge}
    </button>
  )
  if (noTooltip) return button
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      {button}
    </Tooltip>
  )
}

/** Small count badge for icon buttons (unread counts). */
export function CountBadge({ count, tone = 'warn', className }: { count: number; tone?: 'warn' | 'accent'; className?: string }) {
  if (count <= 0) return null
  return (
    <span
      className={cn(
        'pointer-events-none absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-bold leading-none text-white ring-2 ring-panel',
        tone === 'warn' ? 'bg-warn' : 'bg-accent',
        className,
      )}
      aria-hidden
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
