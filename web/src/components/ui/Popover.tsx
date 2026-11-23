import type { ComponentProps } from 'react'
import { Popover as P } from 'radix-ui'
import { cn } from '@/lib/utils'

export const Popover = P.Root
export const PopoverTrigger = P.Trigger
export const PopoverAnchor = P.Anchor

export function PopoverContent({ className, sideOffset = 6, collisionPadding = 8, ...props }: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          'z-[55] animate-pop-in rounded-lg border border-line bg-elevated text-fg shadow-pop focus:outline-none',
          className,
        )}
        {...props}
      />
    </P.Portal>
  )
}
