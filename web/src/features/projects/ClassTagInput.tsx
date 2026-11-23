import { useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import { CLASS_PALETTE } from '@/lib/colors'
import { cn } from '@/lib/utils'

interface ClassTagInputProps {
  id?: string
  value: string[]
  onChange: (value: string[]) => void
  placeholder?: string
  'aria-describedby'?: string
}

function addNames(current: string[], raw: string[]): string[] {
  const next = [...current]
  for (const name of raw.map((n) => n.trim()).filter(Boolean)) {
    if (!next.some((n) => n.toLowerCase() === name.toLowerCase())) next.push(name.slice(0, 100))
  }
  return next
}

/** Chip input for class names: Enter or comma adds, Backspace on empty removes the last, paste splits lines. */
export function ClassTagInput({ id, value, onChange, placeholder = 'Type a class name and press Enter', ...aria }: ClassTagInputProps) {
  const [text, setText] = useState('')

  function commit() {
    if (!text.trim()) return
    onChange(addNames(value, text.split(',')))
    setText('')
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && text.trim())) {
      e.preventDefault()
      commit()
    } else if (e.key === 'Backspace' && !text && value.length) {
      e.preventDefault()
      onChange(value.slice(0, -1))
    }
  }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const data = e.clipboardData.getData('text')
    if (!/[\n,]/.test(data)) return
    e.preventDefault()
    onChange(addNames(value, data.split(/[\n,\r]+/)))
  }

  return (
    <div
      className={cn(
        'flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-line bg-panel-2 px-1.5 py-1 transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25',
      )}
    >
      {value.map((name, i) => (
        <span
          key={name}
          className="inline-flex h-6 items-center gap-1.5 rounded-[5px] border border-line bg-panel pl-1.5 pr-0.5 text-sm text-fg"
        >
          <span className="size-2.5 rounded-sm" style={{ background: CLASS_PALETTE[i % CLASS_PALETTE.length] }} aria-hidden />
          <span className="text-2xs tabular-nums text-dim">{i}</span>
          {name}
          <button
            type="button"
            aria-label={`Remove class ${name}`}
            onClick={() => onChange(value.filter((n) => n !== name))}
            className="grid size-5 place-items-center rounded text-dim hover:bg-hover hover:text-fg"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={commit}
        placeholder={value.length ? '' : placeholder}
        aria-describedby={aria['aria-describedby']}
        className="h-6 min-w-40 flex-1 bg-transparent px-1 text-base text-fg placeholder:text-dim focus:outline-none"
      />
    </div>
  )
}
