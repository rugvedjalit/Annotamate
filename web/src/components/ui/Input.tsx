import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export const inputBase =
  'w-full rounded-md border border-line bg-panel-2 text-fg placeholder:text-dim transition-[border-color,box-shadow] duration-150 hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/25'

export interface InputProps extends Omit<ComponentProps<'input'>, 'size'> {
  leftIcon?: ReactNode
  rightSlot?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  wrapperClassName?: string
}

const sizes = {
  sm: 'h-7 text-sm px-2',
  md: 'h-8 text-base px-2.5',
  lg: 'h-10 text-md px-3',
}

export function Input({ className, leftIcon, rightSlot, size = 'md', wrapperClassName, ...props }: InputProps) {
  if (!leftIcon && !rightSlot) {
    return <input className={cn(inputBase, sizes[size], className)} {...props} />
  }
  return (
    <div className={cn('relative flex items-center', wrapperClassName)}>
      {leftIcon && (
        <span className="pointer-events-none absolute left-2.5 flex text-dim [&_svg]:size-3.5">{leftIcon}</span>
      )}
      <input
        className={cn(inputBase, sizes[size], leftIcon ? 'pl-8' : undefined, rightSlot ? 'pr-8' : undefined, className)}
        {...props}
      />
      {rightSlot && <span className="absolute right-1.5 flex items-center">{rightSlot}</span>}
    </div>
  )
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(inputBase, 'min-h-16 resize-y px-2.5 py-1.5 text-base leading-5', className)} {...props} />
}
