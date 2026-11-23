import { useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type Ref } from 'react'
import type { UserBrief } from '@/lib/types'
import { activeMentionQuery } from '@/lib/mentions'
import { cn } from '@/lib/utils'
import { inputBase } from '@/components/ui/Input'
import { Avatar } from '@/components/ui/Avatar'

interface MentionTextareaProps {
  value: string
  onChange: (value: string) => void
  /** Enter (without Shift) submits. */
  onSubmit?: () => void
  /** People that can be @mentioned. */
  users: readonly UserBrief[]
  placeholder?: string
  disabled?: boolean
  autoFocus?: boolean
  maxLength?: number
  maxRows?: number
  className?: string
  onTyping?: () => void
  onEscape?: () => void
  'aria-label'?: string
  ref?: Ref<HTMLTextAreaElement | null>
}

const LINE_HEIGHT = 20

/** Auto-growing textarea with @username autocomplete (↑/↓ to move, Enter/Tab to insert, Esc to close). */
export function MentionTextarea({
  value,
  onChange,
  onSubmit,
  users,
  placeholder,
  disabled,
  autoFocus,
  maxLength = 4000,
  maxRows = 8,
  className,
  onTyping,
  onEscape,
  ref,
  ...aria
}: MentionTextareaProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)
  useImperativeHandle(ref, () => innerRef.current as HTMLTextAreaElement, [])
  const listId = useId()
  const [caret, setCaret] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [highlight, setHighlight] = useState(0)

  const mention = activeMentionQuery(value, caret)
  const suggestions = useMemo(() => {
    if (!mention) return []
    const q = mention.query
    return users
      .filter((u) => u.username.toLowerCase().startsWith(q) || u.display_name.toLowerCase().includes(q))
      .slice(0, 6)
  }, [mention, users])
  const open = !!mention && suggestions.length > 0 && dismissedAt !== mention.start
  const active = Math.min(highlight, Math.max(suggestions.length - 1, 0))

  // Auto-grow
  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, LINE_HEIGHT * maxRows + 14)}px`
  }, [value, maxRows])

  function insert(user: UserBrief) {
    if (!mention) return
    const before = value.slice(0, mention.start)
    const after = value.slice(caret)
    const text = `${before}@${user.username} ${after.replace(/^\s+/, '')}`
    onChange(text)
    const pos = before.length + user.username.length + 2
    requestAnimationFrame(() => {
      const el = innerRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(pos, pos)
      setCaret(pos)
    })
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((active + 1) % suggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((active - 1 + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const u = suggestions[active]
        if (u) insert(u)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setDismissedAt(mention.start)
        return
      }
    }
    if (e.key === 'Escape' && onEscape) {
      e.preventDefault()
      e.stopPropagation()
      onEscape()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && onSubmit) {
      e.preventDefault()
      onSubmit()
    }
  }

  return (
    <div className="relative w-full">
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Mention someone"
          className="absolute bottom-full left-0 z-30 mb-1.5 w-64 animate-pop-in overflow-hidden rounded-lg border border-line bg-elevated p-1 shadow-pop"
        >
          {suggestions.map((u, i) => (
            <li
              key={u.id}
              id={`${listId}-${u.id}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault()
                insert(u)
              }}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                'flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-base',
                i === active ? 'bg-hover text-fg' : 'text-fg',
              )}
            >
              <Avatar user={u} size="xs" tooltip={false} />
              <span className="truncate">{u.display_name}</span>
              <span className="ml-auto truncate font-mono text-xs text-dim">@{u.username}</span>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={innerRef}
        value={value}
        rows={1}
        maxLength={maxLength}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={aria['aria-label'] ?? placeholder}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && suggestions[active] ? `${listId}-${suggestions[active].id}` : undefined}
        onChange={(e) => {
          onChange(e.target.value)
          setCaret(e.target.selectionStart)
          setHighlight(0)
          onTyping?.()
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
        className={cn(inputBase, 'block resize-none px-2.5 py-[6px] text-base leading-5', className)}
      />
    </div>
  )
}
