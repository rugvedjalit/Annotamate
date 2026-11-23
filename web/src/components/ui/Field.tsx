import { cloneElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { Label as L } from 'radix-ui'
import { cn } from '@/lib/utils'

export function Label({ className, ...props }: ComponentProps<typeof L.Root>) {
  return <L.Root className={cn('text-sm font-medium text-fg', className)} {...props} />
}

interface FieldProps {
  label?: ReactNode
  htmlFor?: string
  hint?: ReactNode
  error?: string | null
  required?: boolean
  className?: string
  children: ReactNode
  /** Right side of the label row (e.g. a "Generate" link). */
  aside?: ReactNode
}

type AriaRequiredProps = { 'aria-required'?: boolean | 'true' | 'false' }

const FORM_CONTROLS = new Set(['input', 'textarea', 'select'])

/**
 * Label + control + hint/error, consistently spaced. Give the control `aria-describedby={`${id}-desc`}`.
 * The required asterisk is decorative and sits outside the `<label>` so it never becomes part of the control's
 * accessible name; the control itself gets `aria-required`.
 */
export function Field({ label, htmlFor, hint, error, required, className, children, aside }: FieldProps) {
  const control =
    required &&
    isValidElement<AriaRequiredProps>(children) &&
    children.props['aria-required'] === undefined &&
    (typeof children.type !== 'string' || FORM_CONTROLS.has(children.type))
      ? cloneElement(children as ReactElement<AriaRequiredProps>, { 'aria-required': true })
      : children
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {(label || aside) && (
        <div className="flex items-center justify-between gap-2">
          {label && (
            <span className="inline-flex items-baseline gap-0.5">
              <Label htmlFor={htmlFor}>{label}</Label>
              {required && (
                <span className="text-sm text-danger" aria-hidden="true">
                  *
                </span>
              )}
            </span>
          )}
          {aside}
        </div>
      )}
      {control}
      {error ? (
        <p id={htmlFor ? `${htmlFor}-desc` : undefined} role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={htmlFor ? `${htmlFor}-desc` : undefined} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
