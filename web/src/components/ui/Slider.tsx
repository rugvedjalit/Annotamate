import type { ComponentProps } from 'react'
import { Slider as S } from 'radix-ui'
import { cn } from '@/lib/utils'

export function Slider({ className, ...props }: ComponentProps<typeof S.Root>) {
  return (
    <S.Root className={cn('relative flex h-5 w-full touch-none select-none items-center', className)} {...props}>
      <S.Track className="relative h-1 grow overflow-hidden rounded-full bg-line-strong">
        <S.Range className="absolute h-full rounded-full bg-accent" />
      </S.Track>
      <S.Thumb
        aria-label={props['aria-label']}
        className="block size-3.5 rounded-full border-2 border-accent bg-white shadow transition-transform hover:scale-110"
      />
    </S.Root>
  )
}
