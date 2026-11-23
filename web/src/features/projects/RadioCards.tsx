import type { ReactNode } from 'react'
import { RadioGroup } from 'radix-ui'
import { cn } from '@/lib/utils'

export interface RadioCardOption<V extends string> {
  value: V
  title: ReactNode
  description?: ReactNode
  icon?: ReactNode
  disabled?: boolean
}

interface RadioCardsProps<V extends string> {
  value: V
  onValueChange: (value: V) => void
  options: readonly RadioCardOption<V>[]
  columns?: 1 | 2 | 3
  className?: string
  'aria-label': string
}

/** Radio group rendered as selectable cards (arrow keys move between options). */
export function RadioCards<V extends string>({ value, onValueChange, options, columns = 1, className, ...aria }: RadioCardsProps<V>) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={(v) => onValueChange(v as V)}
      aria-label={aria['aria-label']}
      className={cn(
        'grid gap-2',
        columns === 3 ? 'sm:grid-cols-3' : columns === 2 ? 'sm:grid-cols-2' : 'grid-cols-1',
        className,
      )}
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className={cn(
            'group flex items-start gap-3 rounded-lg border border-line bg-panel-2 p-3 text-left transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-50',
            'data-[state=checked]:border-accent data-[state=checked]:bg-accent-soft',
          )}
        >
          <span
            aria-hidden
            className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border-[1.5px] border-line-strong group-data-[state=checked]:border-accent"
          >
            <RadioGroup.Indicator className="size-2 rounded-full bg-accent" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-base font-medium text-fg">
              {o.icon}
              {o.title}
            </span>
            {o.description && <span className="mt-0.5 block text-sm text-muted">{o.description}</span>}
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  )
}
