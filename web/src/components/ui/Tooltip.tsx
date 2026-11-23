import { useRef, useState, type ReactNode } from 'react'
import { Tooltip as T } from 'radix-ui'
import { cn } from '@/lib/utils'
import { KbdList } from './Kbd'

export const TooltipProvider = T.Provider

interface TooltipProps {
  content: ReactNode
  /** Shortcut combo(s) shown next to the text. */
  shortcut?: string | readonly string[]
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  children: ReactNode
  disabled?: boolean
  delayDuration?: number
}

/**
 * Hover/keyboard-focus tooltip. It never intercepts clicks, and it does not open when focus lands on the trigger
 * without keyboard navigation (e.g. a popover or menu returning focus to its trigger after a mouse click).
 */
export function Tooltip({ content, shortcut, side = 'bottom', align = 'center', children, disabled, delayDuration }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const hovering = useRef(false)
  if (disabled || (!content && !shortcut)) return <>{children}</>
  const combos = shortcut === undefined ? [] : typeof shortcut === 'string' ? [shortcut] : shortcut

  function onOpenChange(next: boolean) {
    if (next && !hovering.current) {
      const active = document.activeElement
      if (active instanceof HTMLElement && !active.matches(':focus-visible')) return
    }
    setOpen(next)
  }

  return (
    <T.Root delayDuration={delayDuration} open={open} onOpenChange={onOpenChange}>
      <T.Trigger
        asChild
        onPointerEnter={() => {
          hovering.current = true
        }}
        onPointerLeave={() => {
          hovering.current = false
        }}
      >
        {children}
      </T.Trigger>
      <T.Portal>
        <T.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            'pointer-events-none z-[70] flex max-w-xs animate-fade-in items-center gap-2 rounded-md border border-line bg-elevated px-2 py-1 text-xs text-fg shadow-pop',
          )}
        >
          <span>{content}</span>
          {combos.length > 0 && <KbdList combos={combos.slice(0, 2)} />}
        </T.Content>
      </T.Portal>
    </T.Root>
  )
}
