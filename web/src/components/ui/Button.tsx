import type { ComponentProps } from 'react'
import { Slot } from 'radix-ui'
import type { VariantProps } from 'class-variance-authority'
import { buttonVariants } from './variants'
import { LoaderCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {
  loading?: boolean
  asChild?: boolean
}

export function Button({ className, variant, size, loading, asChild, disabled, children, type, ...props }: ButtonProps) {
  if (asChild) {
    return (
      <Slot.Root className={cn(buttonVariants({ variant, size }), className)} {...props}>
        {children}
      </Slot.Root>
    )
  }
  return (
    <button
      type={type ?? 'button'}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <LoaderCircle className="animate-spin" aria-hidden />}
      {children}
    </button>
  )
}
