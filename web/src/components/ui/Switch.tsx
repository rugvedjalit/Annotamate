import type { ComponentProps, ReactNode } from 'react'
import { useId } from 'react'
import { Switch as S } from 'radix-ui'
import { cn } from '@/lib/utils'

export function Switch({ className, ...props }: ComponentProps<typeof S.Root>) {
  return (
    <S.Root
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-transparent bg-dim transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent',
        className,
      )}
      {...props}
    >
      <S.Thumb className="block size-3 translate-x-0.5 rounded-full bg-white shadow transition-transform duration-150 data-[state=checked]:translate-x-[13px]" />
    </S.Root>
  )
}

interface SwitchRowProps {
  label: ReactNode
  description?: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

/** A labelled switch row used in settings lists (the description is the switch's accessible description). */
export function SwitchRow({ label, description, checked, onCheckedChange, disabled, className }: SwitchRowProps) {
  const id = useId()
  const descId = `${id}-desc`
  return (
    <div className={cn('flex items-start justify-between gap-4 py-2', className)}>
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-base text-fg">
          {label}
        </label>
        {description && (
          <div id={descId} className="mt-0.5 text-sm text-muted">
            {description}
          </div>
        )}
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-describedby={description ? descId : undefined}
        className="mt-0.5"
      />
    </div>
  )
}
