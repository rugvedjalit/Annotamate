import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Plus, Search } from 'lucide-react'
import type { ProjectClass } from '@/lib/types'
import { cn } from '@/lib/utils'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/Popover'
import { KeyCap } from '@/components/ui/Kbd'
import { Spinner } from '@/components/ui/Feedback'
import { canCreateClass, filterClasses } from './classPickerLogic'

export interface ClassPickerProps {
  /** Viewport coordinates of the anchor point (near the box's top-right corner). */
  anchor: { x: number; y: number }
  classes: readonly ProjectClass[]
  /** Highlighted initially (e.g. the active class or the box's current class). */
  initialClassId?: number | null
  allowCreate: boolean
  title?: string
  /** Text of the Escape hint ("discard box" for new boxes, "cancel" otherwise). */
  escapeHint?: string
  onPick: (classId: number) => void
  onCreate: (name: string) => Promise<ProjectClass | null>
  onDismiss: () => void
}

/**
 * Popover next to a box: type to filter, ↑/↓ to move, Enter to assign, 1–9 to pick by hotkey,
 * "Create class" when permitted, Esc (or clicking elsewhere) to dismiss.
 */
export function ClassPicker({
  anchor,
  classes,
  initialClassId,
  allowCreate,
  title = 'Assign class',
  escapeHint = 'discard box',
  onPick,
  onCreate,
  onDismiss,
}: ClassPickerProps) {
  const listId = useId()
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const options = useMemo(() => filterClasses(classes, query), [classes, query])
  const showCreate = canCreateClass(classes, query, allowCreate)
  const count = options.length + (showCreate ? 1 : 0)
  const initialIndex = Math.max(0, options.findIndex((o) => o.cls.id === initialClassId))
  const [highlight, setHighlight] = useState(initialIndex)
  const [prevQuery, setPrevQuery] = useState(query)
  if (prevQuery !== query) {
    setPrevQuery(query)
    setHighlight(0)
  }
  const active = count === 0 ? -1 : Math.min(highlight, count - 1)
  const listRef = useRef<HTMLDivElement>(null)

  const virtualRef = useRef({
    getBoundingClientRect: () => ({ x: anchor.x, y: anchor.y, width: 0, height: 0, top: anchor.y, left: anchor.x, right: anchor.x, bottom: anchor.y, toJSON: () => ({}) }) as DOMRect,
  })
  useEffect(() => {
    virtualRef.current.getBoundingClientRect = () =>
      ({ x: anchor.x, y: anchor.y, width: 0, height: 0, top: anchor.y, left: anchor.x, right: anchor.x, bottom: anchor.y, toJSON: () => ({}) }) as DOMRect
  }, [anchor.x, anchor.y])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [active])

  async function create() {
    if (creating) return
    setCreating(true)
    try {
      const cls = await onCreate(query.trim())
      if (cls) onPick(cls.id)
    } finally {
      setCreating(false)
    }
  }

  function choose(index: number) {
    if (index < 0) return
    const opt = options[index]
    if (opt) onPick(opt.cls.id)
    else if (showCreate && index === options.length) void create()
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (count) setHighlight((active + 1) % count)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (count) setHighlight((active - 1 + count) % count)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(active)
    } else if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      const cls = classes[Number(e.key) - 1]
      if (cls) onPick(cls.id)
    }
  }

  return (
    <Popover open onOpenChange={(open) => !open && onDismiss()}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-60 p-1.5"
        aria-label={title}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex h-[30px] items-center gap-2 rounded-md border border-accent bg-panel-2 px-2 ring-[3px] ring-accent/20">
          <Search className="size-3.5 shrink-0 text-dim" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={allowCreate ? 'Filter or create a class' : 'Filter classes'}
            aria-label="Filter classes"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-base text-fg placeholder:text-dim focus:outline-none"
          />
        </div>
        <div className="px-2 pb-1 pt-2 text-2xs font-bold uppercase tracking-wider text-dim">{title} · 1–9</div>
        <div ref={listRef} id={listId} role="listbox" aria-label="Classes" className="max-h-64 overflow-y-auto">
          {options.map((o, i) => (
            <div
              key={o.cls.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              data-active={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(o.cls.id)}
              onMouseMove={() => i !== active && setHighlight(i)}
              className={cn(
                'flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-base',
                i === active ? 'bg-accent-soft text-fg' : 'text-fg/90',
              )}
            >
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: o.cls.color }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {o.match ? (
                  <>
                    {o.cls.name.slice(0, o.match[0])}
                    <mark className="bg-transparent font-bold text-accent-text">{o.cls.name.slice(o.match[0], o.match[1])}</mark>
                    {o.cls.name.slice(o.match[1])}
                  </>
                ) : (
                  o.cls.name
                )}
              </span>
              {o.hotkey !== null && <KeyCap>{o.hotkey}</KeyCap>}
            </div>
          ))}
          {showCreate && (
            <div
              id={`${listId}-${options.length}`}
              role="option"
              aria-selected={active === options.length}
              data-active={active === options.length}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void create()}
              onMouseMove={() => setHighlight(options.length)}
              className={cn(
                'flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-base text-muted',
                active === options.length && 'bg-accent-soft text-fg',
              )}
            >
              {creating ? <Spinner className="size-3" /> : <Plus className="size-3" aria-hidden />}
              <span className="truncate">Create class “{query.trim()}”</span>
            </div>
          )}
          {count === 0 && <div className="px-2 py-3 text-center text-sm text-muted">No matching class</div>}
        </div>
        <div className="mt-1.5 flex gap-3.5 border-t border-line px-1.5 pb-0.5 pt-1.5 text-2xs text-dim">
          <span className="inline-flex items-center gap-1">
            <KeyCap>↵</KeyCap>assign
          </span>
          <span className="inline-flex items-center gap-1">
            <KeyCap>Esc</KeyCap>
            {escapeHint}
          </span>
        </div>
      </PopoverContent>
    </Popover>
  )
}
