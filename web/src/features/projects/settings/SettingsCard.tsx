import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface SettingsCardProps {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
  tone?: 'default' | 'danger'
}

export function SettingsCard({ title, description, children, footer, className, tone = 'default' }: SettingsCardProps) {
  return (
    <section
      className={cn(
        'rounded-xl border bg-panel shadow-card',
        tone === 'danger' ? 'border-danger/40' : 'border-line',
        className,
      )}
    >
      <header className="border-b border-line px-5 py-3.5">
        <h2 className={cn('text-md font-semibold', tone === 'danger' ? 'text-danger' : 'text-fg')}>{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </header>
      <div className="px-5 py-4">{children}</div>
      {footer && <footer className="flex items-center justify-end gap-2 border-t border-line bg-panel-2/50 px-5 py-3">{footer}</footer>}
    </section>
  )
}

export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-baseline gap-3 py-1.5 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </div>
  )
}
