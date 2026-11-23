import type { ComponentProps, ReactNode } from 'react'
import { Dialog as D } from 'radix-ui'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

export const Dialog = D.Root

const sizes = {
  sm: 'w-[min(400px,calc(100vw-32px))]',
  md: 'w-[min(520px,calc(100vw-32px))]',
  lg: 'w-[min(680px,calc(100vw-32px))]',
  xl: 'w-[min(880px,calc(100vw-32px))]',
}

interface DialogContentProps extends Omit<ComponentProps<typeof D.Content>, 'title'> {
  title: ReactNode
  description?: ReactNode
  size?: keyof typeof sizes
  hideClose?: boolean
  /** Rendered in a sticky footer row (buttons). */
  footer?: ReactNode
  bodyClassName?: string
}

export function DialogContent({
  title,
  description,
  size = 'md',
  hideClose,
  footer,
  children,
  className,
  bodyClassName,
  ...props
}: DialogContentProps) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 animate-fade-in bg-overlay backdrop-blur-[1px]" />
      <D.Content
        className={cn(
          'fixed left-1/2 top-[max(10vh,24px)] z-50 flex max-h-[calc(100vh-max(10vh,24px)-24px)] -translate-x-1/2 animate-pop-in flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-pop focus:outline-none',
          sizes[size],
          className,
        )}
        {...props}
      >
        <div className="flex items-start gap-3 border-b border-line px-5 pb-3.5 pt-4">
          <div className="min-w-0 flex-1">
            <D.Title className="text-md font-semibold text-fg">{title}</D.Title>
            {description ? (
              <D.Description className="mt-1 text-sm text-muted">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</D.Description>
            )}
          </div>
          {!hideClose && (
            <D.Close
              aria-label="Close"
              className="-mr-1.5 -mt-0.5 grid size-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-fg"
            >
              <X className="size-4" />
            </D.Close>
          )}
        </div>
        <div className={cn('min-h-0 flex-1 overflow-y-auto px-5 py-4', bodyClassName)}>{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line bg-panel-2/50 px-5 py-3">{footer}</div>}
      </D.Content>
    </D.Portal>
  )
}
