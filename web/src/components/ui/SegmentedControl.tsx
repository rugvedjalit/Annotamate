import type { ReactNode } from 'react'
import { ToggleGroup } from 'radix-ui'
import { cn } from '@/lib/utils'

interface Option<V extends string> {
  value: V
  label: ReactNode
  icon?: ReactNode
  'aria-label'?: string
}

interface SegmentedControlProps<V extends string> {
  value: V
  onValueChange: (value: V) => void
  options: readonly Option<V>[]
  size?: 'sm' | 'md'
  className?: string
  'aria-label': string
}

/** Single-choice segmented control (keyboard: arrow keys move between options). */
export function SegmentedControl<V extends string>({
  value,
  onValueChange,
  options,
  size = 'md',
  className,
  ...aria
}: SegmentedControlProps<V>) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(v) => v && onValueChange(v as V)}
      aria-label={aria['aria-label']}
      className={cn('inline-flex rounded-md border border-line bg-panel-2 p-0.5', className)}
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          aria-label={o['aria-label']}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-[5px] font-medium text-muted transition-colors hover:text-fg data-[state=on]:bg-panel data-[state=on]:text-fg data-[state=on]:shadow-card [&_svg]:size-3.5',
            size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-sm',
          )}
        >
          {o.icon}
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
