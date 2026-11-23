import { useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { formatPx } from '@/lib/format'

interface NumberFieldProps {
  label: string
  value: number
  onCommit: (value: number) => void
  disabled?: boolean
  min?: number
}

/** Compact numeric input: commits on Enter/blur, Esc reverts, ↑/↓ step 1 (Shift 10). */
export function NumberField({ label, value, onCommit, disabled, min = 0 }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? formatPx(Math.round(value * 10) / 10)

  function commit(text: string) {
    setDraft(null)
    const n = Number(text)
    if (text.trim() === '' || !Number.isFinite(n)) return
    const v = Math.max(min, n)
    if (v !== value) onCommit(v)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(e.currentTarget.value)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setDraft(null)
      e.currentTarget.blur()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const step = (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1)
      onCommit(Math.max(min, Math.round(value) + step))
      setDraft(null)
    }
  }

  return (
    <label
      className={cn(
        'flex h-7 items-center gap-2 rounded-md border border-line bg-panel-2 px-2 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25',
        disabled && 'opacity-60',
      )}
    >
      <span className="w-3 text-2xs font-bold text-dim">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        disabled={disabled}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => draft !== null && commit(e.target.value)}
        onKeyDown={onKeyDown}
        className="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg tabular focus:outline-none"
      />
    </label>
  )
}
