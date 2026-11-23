import type { ReactNode } from 'react'
import { AlertDialog as A } from 'radix-ui'
import { cn } from '@/lib/utils'

export const AlertDialog = A.Root
export const AlertDialogCancel = A.Cancel

interface AlertDialogContentProps {
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer: ReactNode
  icon?: ReactNode
  className?: string
}

export function AlertDialogContent({ title, description, children, footer, icon, className }: AlertDialogContentProps) {
  return (
    <A.Portal>
      <A.Overlay className="fixed inset-0 z-50 animate-fade-in bg-overlay" />
      <A.Content
        className={cn(
          'fixed left-1/2 top-[18vh] z-50 w-[min(440px,calc(100vw-32px))] -translate-x-1/2 animate-pop-in rounded-xl border border-line bg-panel p-5 shadow-pop focus:outline-none',
          className,
        )}
      >
        <div className="flex gap-3.5">
          {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
          <div className="min-w-0 flex-1">
            <A.Title className="text-md font-semibold text-fg">{title}</A.Title>
            {description ? (
              <A.Description className="mt-1.5 text-base text-muted">{description}</A.Description>
            ) : (
              <A.Description className="sr-only">{typeof title === 'string' ? title : 'Confirm'}</A.Description>
            )}
            {children && <div className="mt-3">{children}</div>}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">{footer}</div>
      </A.Content>
    </A.Portal>
  )
}
