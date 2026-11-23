import type { ComponentProps, ReactNode } from 'react'
import { useId } from 'react'
import { Checkbox as C } from 'radix-ui'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Checkbox({ className, ...props }: ComponentProps<typeof C.Root>) {
  return (
    <C.Root
      className={cn(
        'grid size-[15px] shrink-0 place-items-center rounded-[4px] border-[1.5px] border-line-strong bg-panel-2 text-accent-fg transition-colors hover:border-dim disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent',
        className,
      )}
      {...props}
    >
      <C.Indicator className="grid place-items-center">
        {props.checked === 'indeterminate' ? (
          <Minus className="size-3" strokeWidth={3} />
        ) : (
          <Check className="size-3" strokeWidth={3} />
        )}
      </C.Indicator>
    </C.Root>
  )
}

interface CheckboxFieldProps {
  label: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

export function CheckboxField({ label, checked, onCheckedChange, disabled, className }: CheckboxFieldProps) {
  const id = useId()
  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onCheckedChange(v === true)} disabled={disabled} />
      <label htmlFor={id} className="cursor-pointer select-none text-base text-fg">
        {label}
      </label>
    </div>
  )
}
