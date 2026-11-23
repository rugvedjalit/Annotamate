import type { ComponentProps } from 'react'
import { Tabs as T } from 'radix-ui'
import { cn } from '@/lib/utils'

export const Tabs = T.Root

export function TabsList({
  className,
  variant = 'underline',
  ...props
}: ComponentProps<typeof T.List> & { variant?: 'underline' | 'pills' }) {
  return (
    <T.List
      data-variant={variant}
      className={cn(
        'group/tabs flex shrink-0 items-center',
        variant === 'underline' ? 'gap-1 border-b border-line px-2' : 'gap-1 rounded-md bg-panel-2 p-0.5',
        className,
      )}
      {...props}
    />
  )
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        'relative inline-flex items-center gap-1.5 whitespace-nowrap rounded-md font-medium text-muted transition-colors hover:text-fg focus-visible:outline-offset-[-2px] disabled:opacity-50 [&_svg]:size-3.5',
        // underline variant
        'group-data-[variant=underline]/tabs:h-9 group-data-[variant=underline]/tabs:px-2 group-data-[variant=underline]/tabs:text-sm',
        'group-data-[variant=underline]/tabs:after:absolute group-data-[variant=underline]/tabs:after:inset-x-1.5 group-data-[variant=underline]/tabs:after:-bottom-px group-data-[variant=underline]/tabs:after:h-0.5 group-data-[variant=underline]/tabs:after:rounded-full',
        'group-data-[variant=underline]/tabs:data-[state=active]:text-fg group-data-[variant=underline]/tabs:data-[state=active]:after:bg-accent',
        // pills variant
        'group-data-[variant=pills]/tabs:h-7 group-data-[variant=pills]/tabs:rounded-[5px] group-data-[variant=pills]/tabs:px-2.5 group-data-[variant=pills]/tabs:text-sm',
        'group-data-[variant=pills]/tabs:data-[state=active]:bg-panel group-data-[variant=pills]/tabs:data-[state=active]:text-fg group-data-[variant=pills]/tabs:data-[state=active]:shadow-card',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: ComponentProps<typeof T.Content>) {
  return <T.Content className={cn('min-h-0 focus-visible:outline-none', className)} {...props} />
}
