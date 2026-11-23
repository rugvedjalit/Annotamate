import { useId, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { ErrorBoundary } from '@/components/ErrorBoundary'

interface SectionProps {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
  /** Name used by the error boundary fallback. */
  name: string
}

/**
 * Dashboard card with its own error boundary (a crash in one section leaves the others working).
 * Exposed as a region named by its title.
 */
export function Section({ title, description, actions, children, className, bodyClassName, name }: SectionProps) {
  const titleId = useId()
  return (
    <section
      aria-labelledby={titleId}
      className={cn('flex min-w-0 flex-col rounded-xl border border-line bg-panel shadow-card', className)}
    >
      <header className="flex min-h-11 items-center gap-3 border-b border-line px-4 py-2">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-base font-semibold text-fg">
            {title}
          </h2>
          {description && <p className="truncate text-xs text-muted">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </header>
      <div className={cn('min-w-0 flex-1 p-4', bodyClassName)}>
        <ErrorBoundary name={name}>{children}</ErrorBoundary>
      </div>
    </section>
  )
}
