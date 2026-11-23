// Spinner, Skeleton, EmptyState, ErrorState, Progress.
import type { ReactNode } from 'react'
import { LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react'
import { Progress as P } from 'radix-ui'
import { cn } from '@/lib/utils'
import { errorMessage } from '@/lib/api'
import { Button } from './Button'

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return <LoaderCircle className={cn('size-4 animate-spin text-muted', className)} aria-label={label} role="status" />
}

/** Centred spinner filling its container. */
export function LoadingBlock({ className, label }: { className?: string; label?: string }) {
  return (
    <div className={cn('flex h-full min-h-24 w-full items-center justify-center gap-2 text-sm text-muted', className)}>
      <Spinner />
      {label}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-shimmer rounded-md bg-hover', className)} aria-hidden />
}

export function SkeletonRows({ rows = 6, className, rowClassName }: { rows?: number; className?: string; rowClassName?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn('h-7', rowClassName)} />
      ))}
    </div>
  )
}

interface EmptyStateProps {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
  compact?: boolean
}

export function EmptyState({ icon, title, description, action, className, compact }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-1.5 px-4 py-6' : 'gap-2 px-6 py-12',
        className,
      )}
    >
      {icon && (
        <div
          className={cn(
            'mb-1 grid place-items-center rounded-xl bg-panel-2 text-dim ring-1 ring-line',
            compact ? 'size-9 [&_svg]:size-4' : 'size-12 [&_svg]:size-5',
          )}
        >
          {icon}
        </div>
      )}
      <div className={cn('font-semibold text-fg', compact ? 'text-sm' : 'text-md')}>{title}</div>
      {description && <div className={cn('max-w-sm text-muted', compact ? 'text-xs' : 'text-sm')}>{description}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

interface ErrorStateProps {
  error: unknown
  onRetry?: () => void
  title?: string
  className?: string
  compact?: boolean
}

/** Inline error with a retry button (every query uses this for its error state). */
export function ErrorState({ error, onRetry, title = 'Could not load this', className, compact }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-2 text-center',
        compact ? 'px-3 py-4' : 'px-6 py-10',
        className,
      )}
    >
      <TriangleAlert className={cn('text-danger', compact ? 'size-4' : 'size-5')} aria-hidden />
      <div className={cn('font-semibold text-fg', compact ? 'text-sm' : 'text-md')}>{title}</div>
      <div className="max-w-sm text-sm text-muted">{errorMessage(error)}</div>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry} className="mt-1">
          <RefreshCw />
          Retry
        </Button>
      )}
    </div>
  )
}

export function Progress({ value, className, indicatorClassName, label }: { value: number; className?: string; indicatorClassName?: string; label?: string }) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <P.Root value={v} aria-label={label} className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-hover', className)}>
      <P.Indicator
        className={cn('h-full rounded-full bg-accent transition-[width] duration-300', indicatorClassName)}
        style={{ width: `${v}%` }}
      />
    </P.Root>
  )
}
