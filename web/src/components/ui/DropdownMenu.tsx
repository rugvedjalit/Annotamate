import type { ComponentProps, ReactNode } from 'react'
import { DropdownMenu as M } from 'radix-ui'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Kbd } from './Kbd'
import { menuContentClass, menuDangerClass, menuItemClass, menuLabelClass, menuSeparatorClass } from './menu'

export const DropdownMenu = M.Root
export const DropdownMenuTrigger = M.Trigger
export const DropdownMenuSub = M.Sub
export const DropdownMenuRadioGroup = M.RadioGroup

export function DropdownMenuContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(menuContentClass, className)}
        {...props}
      />
    </M.Portal>
  )
}

interface ItemProps extends ComponentProps<typeof M.Item> {
  icon?: ReactNode
  shortcut?: string
  danger?: boolean
}

export function DropdownMenuItem({ className, icon, shortcut, danger, children, ...props }: ItemProps) {
  return (
    <M.Item className={cn(menuItemClass, danger && menuDangerClass, className)} {...props}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <Kbd combo={shortcut} className="ml-4" />}
    </M.Item>
  )
}

export function DropdownMenuRadioItem({ className, children, ...props }: ComponentProps<typeof M.RadioItem>) {
  return (
    <M.RadioItem className={cn(menuItemClass, 'pl-7', className)} {...props}>
      <M.ItemIndicator className="absolute left-2 flex">
        <Check className="!text-accent-text" />
      </M.ItemIndicator>
      {children}
    </M.RadioItem>
  )
}

export function DropdownMenuLabel({ className, ...props }: ComponentProps<typeof M.Label>) {
  return <M.Label className={cn(menuLabelClass, className)} {...props} />
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof M.Separator>) {
  return <M.Separator className={cn(menuSeparatorClass, className)} {...props} />
}

export function DropdownMenuSubTrigger({
  className,
  icon,
  children,
  ...props
}: ComponentProps<typeof M.SubTrigger> & { icon?: ReactNode }) {
  return (
    <M.SubTrigger className={cn(menuItemClass, 'data-[state=open]:bg-hover', className)} {...props}>
      {icon}
      <span className="flex-1">{children}</span>
      <ChevronRight className="ml-auto" />
    </M.SubTrigger>
  )
}

export function DropdownMenuSubContent({ className, ...props }: ComponentProps<typeof M.SubContent>) {
  return (
    <M.Portal>
      <M.SubContent sideOffset={4} collisionPadding={8} className={cn(menuContentClass, className)} {...props} />
    </M.Portal>
  )
}
