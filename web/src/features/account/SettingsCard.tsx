import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface SettingsCardProps {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
  actions?: ReactNode
}

/** A titled section card used on the account page. */
export function SettingsCard({ title, description, children, footer, className, actions }: SettingsCardProps) {
  return (
    <section className={cn('rounded-xl border border-line bg-panel shadow-card', className)}>
      <header className="flex items-start gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-md font-semibold text-fg">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
        </div>
        {actions}
      </header>
      <div className="px-5 py-4">{children}</div>
      {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
    </section>
  )
}
