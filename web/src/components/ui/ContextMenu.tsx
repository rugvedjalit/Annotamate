import type { ComponentProps, ReactNode } from 'react'
import { ContextMenu as M } from 'radix-ui'
import { cn } from '@/lib/utils'
import { Kbd } from './Kbd'
import { menuContentClass, menuDangerClass, menuItemClass, menuSeparatorClass } from './menu'

export const ContextMenu = M.Root
export const ContextMenuTrigger = M.Trigger

export function ContextMenuContent({ className, ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content collisionPadding={8} className={cn(menuContentClass, className)} {...props} />
    </M.Portal>
  )
}

interface ItemProps extends ComponentProps<typeof M.Item> {
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
}

export function ContextMenuItem({ className, icon, shortcut, danger, children, ...props }: ItemProps) {
  return (
    <M.Item className={cn(menuItemClass, danger && menuDangerClass, className)} {...props}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <Kbd combo={shortcut} className="ml-4" />}
    </M.Item>
  )
}

export function ContextMenuSeparator({ className, ...props }: ComponentProps<typeof M.Separator>) {
  return <M.Separator className={cn(menuSeparatorClass, className)} {...props} />
}
