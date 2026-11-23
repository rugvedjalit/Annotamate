import type { ComponentProps, Ref } from 'react'
import { ScrollArea as S } from 'radix-ui'
import { cn } from '@/lib/utils'

interface ScrollAreaProps extends ComponentProps<typeof S.Root> {
  viewportRef?: Ref<HTMLDivElement>
  viewportClassName?: string
}

/** Overlay scrollbars that match the theme. */
export function ScrollArea({ className, children, viewportRef, viewportClassName, ...props }: ScrollAreaProps) {
  return (
    <S.Root type="hover" className={cn('relative overflow-hidden', className)} {...props}>
      <S.Viewport ref={viewportRef} className={cn('size-full rounded-[inherit] [&>div]:!block', viewportClassName)}>
        {children}
      </S.Viewport>
      <S.Scrollbar orientation="vertical" className="flex w-2 touch-none select-none p-px transition-colors">
        <S.Thumb className="relative flex-1 rounded-full bg-line-strong hover:bg-dim" />
      </S.Scrollbar>
      <S.Scrollbar orientation="horizontal" className="flex h-2 touch-none select-none flex-col p-px">
        <S.Thumb className="relative flex-1 rounded-full bg-line-strong hover:bg-dim" />
      </S.Scrollbar>
      <S.Corner />
    </S.Root>
  )
}
