import type { ReactNode } from 'react'
import { Select as S } from 'radix-ui'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SelectItem<V extends string = string> {
  value: V
  label: ReactNode
  /** Text used for type-ahead when label is not a string. */
  textValue?: string
  icon?: ReactNode
  description?: ReactNode
  disabled?: boolean
}

interface SelectProps<V extends string> {
  value: V | undefined
  onValueChange: (value: V) => void
  items: readonly SelectItem<V>[]
  placeholder?: string
  size?: 'sm' | 'md'
  disabled?: boolean
  className?: string
  contentClassName?: string
  id?: string
  'aria-label'?: string
  align?: 'start' | 'center' | 'end'
}

export function Select<V extends string>({
  value,
  onValueChange,
  items,
  placeholder,
  size = 'md',
  disabled,
  className,
  contentClassName,
  id,
  align = 'start',
  ...aria
}: SelectProps<V>) {
  const current = items.find((i) => i.value === value)
  return (
    <S.Root value={value} onValueChange={(v) => onValueChange(v as V)} disabled={disabled}>
      <S.Trigger
        id={id}
        aria-label={aria['aria-label']}
        className={cn(
          'inline-flex w-full min-w-0 items-center justify-between gap-2 rounded-md border border-line bg-panel-2 text-left text-fg transition-colors hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60 data-[placeholder]:text-dim',
          size === 'sm' ? 'h-7 px-2 text-sm' : 'h-8 px-2.5 text-base',
          className,
        )}
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          {current?.icon}
          <S.Value placeholder={placeholder}>{current?.label}</S.Value>
        </span>
        <S.Icon className="shrink-0 text-dim">
          <ChevronDown className="size-3.5" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content
          position="popper"
          sideOffset={4}
          align={align}
          collisionPadding={8}
          className={cn(
            'z-[60] max-h-[min(var(--radix-select-content-available-height),360px)] min-w-[var(--radix-select-trigger-width)] animate-pop-in overflow-hidden rounded-lg border border-line bg-elevated p-1 shadow-pop',
            contentClassName,
          )}
        >
          <S.Viewport>
            {items.map((item) => (
              <S.Item
                key={item.value}
                value={item.value}
                disabled={item.disabled}
                textValue={item.textValue ?? (typeof item.label === 'string' ? item.label : item.value)}
                className="relative flex cursor-pointer select-none items-center gap-2 rounded-md py-1.5 pl-2 pr-7 text-base text-fg outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-hover data-[disabled]:opacity-50"
              >
                {item.icon}
                <div className="min-w-0">
                  <S.ItemText>{item.label}</S.ItemText>
                  {item.description && <div className="text-xs text-muted">{item.description}</div>}
                </div>
                <S.ItemIndicator className="absolute right-2 text-accent-text">
                  <Check className="size-3.5" />
                </S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  )
}
