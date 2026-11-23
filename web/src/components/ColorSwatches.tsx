import { useState } from 'react'
import { Check } from 'lucide-react'
import { cn, contrastText, isHexColor } from '@/lib/utils'
import { Input } from '@/components/ui/Input'

interface ColorSwatchesProps {
  value: string
  onChange: (color: string) => void
  colors: readonly string[]
  /** Show a hex input below the swatches. */
  allowCustom?: boolean
  className?: string
  label?: string
}

/** Keyboard-accessible colour picker (radio group of swatches + optional hex input). */
export function ColorSwatches({ value, onChange, colors, allowCustom, className, label = 'Colour' }: ColorSwatchesProps) {
  const [hex, setHex] = useState(value)
  const [prevValue, setPrevValue] = useState(value)
  if (prevValue !== value) {
    setPrevValue(value)
    setHex(value)
  }
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {colors.map((c) => {
          const selected = c.toLowerCase() === value.toLowerCase()
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={c}
              onClick={() => onChange(c)}
              className={cn(
                'grid size-6 place-items-center rounded-md ring-offset-2 ring-offset-panel transition-transform hover:scale-110',
                selected && 'ring-2 ring-fg/70',
              )}
              style={{ background: c, color: contrastText(c) }}
            >
              {selected && <Check className="size-3.5" strokeWidth={3} />}
            </button>
          )
        })}
      </div>
      {allowCustom && (
        <div className="flex items-center gap-2">
          <span className="size-6 shrink-0 rounded-md border border-line" style={{ background: isHexColor(hex) ? hex : 'transparent' }} />
          <Input
            size="sm"
            value={hex}
            aria-label="Hex colour"
            className="w-28 font-mono"
            maxLength={7}
            onChange={(e) => {
              const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`
              setHex(v)
              if (isHexColor(v)) onChange(v.toLowerCase())
            }}
          />
        </div>
      )}
    </div>
  )
}
