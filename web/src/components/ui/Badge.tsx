import type { ComponentProps } from 'react'
import type { VariantProps } from 'class-variance-authority'
import { badgeVariants } from './variants'
import { cn } from '@/lib/utils'
import type { LabelFormat } from '@/lib/types'
import { FORMAT_LABELS } from '@/lib/status'

export function Badge({
  className,
  variant,
  size,
  ...props
}: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant, size }), className)} {...props} />
}

export function FormatBadge({ format, className }: { format: LabelFormat; className?: string }) {
  return (
    <Badge variant="accent" className={className} title={`Labels are written in ${FORMAT_LABELS[format]} format`}>
      {FORMAT_LABELS[format]}
    </Badge>
  )
}
