import { useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Eye, EyeOff, Lock, LockOpen, Plus, Search, Trash2, TriangleAlert } from 'lucide-react'
import { UNKNOWN_CLASS_COLOR } from '@/lib/colors'
import type { EditorBox } from '@/lib/boxes'
import { cn } from '@/lib/utils'
import { useBindings } from '@/hooks/useBindings'
import { useSettings } from '@/stores/settings'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { KeyCap } from '@/components/ui/Kbd'
import { Switch } from '@/components/ui/Switch'
import { Select } from '@/components/ui/Select'
import { CheckboxField } from '@/components/ui/Checkbox'
import { Tooltip } from '@/components/ui/Tooltip'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/ContextMenu'
import { NumberField } from './NumberField'
import { useAnnotator } from './store'
import { useWorkspace } from './workspaceContext'

function SectionHeader({ title, count, children }: { title: string; count?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 pl-3 pr-1.5">
      <h3 className="text-2xs font-bold uppercase tracking-[0.08em] text-muted">{title}</h3>
      {count !== undefined && <span className="text-xs text-dim tabular">{count}</span>}
      <span className="flex-1" />
      {children}
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ classes

function ClassesSection() {
  const ws = useWorkspace()
  const bindings = useBindings()
  const activeClassId = useAnnotator((s) => s.activeClassId)
  const selectedIds = useAnnotator((s) => s.selectedIds)
  const ask = useSettings((s) => s.settings.ask_class_after_draw)
  const update = useSettings((s) => s.update)
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const canAdd = ws.project.permissions.can_add_classes

  const counts = useMemo(() => {
    const m = new Map<number, number>()
    for (const b of ws.doc.boxes) if (b.classId !== null) m.set(b.classId, (m.get(b.classId) ?? 0) + 1)
    return m
  }, [ws.doc.boxes])

  const unknown = useMemo(() => {
    const m = new Map<string, number>()
    for (const b of ws.doc.boxes) {
      if (b.classId === null) {
        const label = b.rawLabel ?? '?'
        m.set(label, (m.get(label) ?? 0) + 1)
      }
    }
    return [...m.entries()]
  }, [ws.doc.boxes])

  const q = filter.trim().toLowerCase()
  const shown = ws.classes.map((c, i) => ({ c, i })).filter(({ c }) => !q || c.name.toLowerCase().includes(q))
  const exact = ws.classes.find((c) => c.name.toLowerCase() === q)

  const choose = (id: number) => {
    useAnnotator.getState().setActiveClassId(id)
    if (selectedIds.length && ws.editable) ws.actions.assignClass(selectedIds, id)
  }

  async function onFilterKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      setFilter('')
      return
    }
    if (e.key !== 'Enter' || !q) return
    e.preventDefault()
    if (exact) {
      choose(exact.id)
      setFilter('')
    } else if (shown.length === 1) {
      choose(shown[0]!.c.id)
      setFilter('')
    } else if (canAdd) {
      const created = await ws.actions.createClass(filter)
      if (created) {
        choose(created.id)
        setFilter('')
      }
    }
  }

  return (
    <section aria-label="Classes" className="flex max-h-[42%] min-h-0 shrink-0 flex-col border-b border-line pb-2">
      <SectionHeader title="Classes" count={ws.classes.length}>
        {canAdd && (
          <IconButton size="sm" label="Add a class" icon={<Plus />} onClick={() => inputRef.current?.focus()} />
        )}
      </SectionHeader>
      <div className="px-2.5">
        <Input
          ref={inputRef}
          size="sm"
          leftIcon={<Search />}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => void onFilterKey(e)}
          placeholder={canAdd ? 'Filter or add a class' : 'Filter classes'}
          aria-label={canAdd ? 'Filter or add a class (Enter adds)' : 'Filter classes'}
        />
      </div>
      <div role="list" className="mt-1.5 min-h-0 flex-1 overflow-y-auto px-1.5">
        {shown.map(({ c, i }) => {
          const active = c.id === activeClassId
          const hotkey = i < 9 ? bindings[`class.${i + 1}` as 'class.1'][0] : undefined
          return (
            <Tooltip
              key={c.id}
              content={selectedIds.length ? `Set active and assign to ${selectedIds.length} selected` : 'Set as active class'}
              side="left"
              delayDuration={700}
            >
              <button
                type="button"
                role="listitem"
                aria-current={active || undefined}
                onClick={() => choose(c.id)}
                className={cn(
                  'flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-base transition-colors',
                  active ? 'bg-hover text-fg shadow-[inset_2px_0_0_var(--accent)]' : 'text-fg/85 hover:bg-hover',
                )}
              >
                <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: c.color }} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="text-xs text-dim tabular" aria-label={`${counts.get(c.id) ?? 0} on this image`}>
                  {counts.get(c.id) ?? 0}
                </span>
                {hotkey && <KeyCap>{hotkey}</KeyCap>}
              </button>
            </Tooltip>
          )
        })}
        {q && !exact && canAdd && (
          <button
            type="button"
            onClick={() => void ws.actions.createClass(filter).then((c) => c && (choose(c.id), setFilter('')))}
            className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-base text-muted hover:bg-hover hover:text-fg"
          >
            <Plus className="size-3" aria-hidden />
            Create class “{filter.trim()}”
          </button>
        )}
        {ws.classes.length === 0 && !q && (
          <p className="px-2 py-2 text-sm text-muted">
            No classes yet.{canAdd ? ' Type a name above and press Enter.' : ' Ask a manager to add classes.'}
          </p>
        )}
      </div>
      {unknown.length > 0 && (
        <div className="mx-2.5 mt-2 rounded-md border border-warn/30 bg-warn-soft px-2.5 py-2 text-xs">
          <div className="flex items-center gap-1.5 font-medium text-fg">
            <TriangleAlert className="size-3.5 text-warn" aria-hidden />
            Unknown labels on this image
          </div>
          <ul className="mt-1 flex flex-col gap-1">
            {unknown.map(([label, n]) => (
              <li key={label} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
                <span className="min-w-0 basis-full truncate">
                  “<span className="font-mono text-fg">{label}</span>” · {n} box{n === 1 ? '' : 'es'}
                </span>
                {ws.editable && ws.classes.length > 0 && (
                  <Select
                    size="sm"
                    aria-label={`Map “${label}” to a class`}
                    className="h-6 w-32"
                    placeholder="Map to class…"
                    value={undefined}
                    onValueChange={(v) => ws.actions.mapUnknownLabel(label, Number(v))}
                    items={ws.classes.map((c) => ({ value: String(c.id), label: c.name }))}
                  />
                )}
                {ws.editable && canAdd && !ws.classes.some((c) => c.name === label) && (
                  <button
                    type="button"
                    className="shrink-0 font-medium text-accent-text hover:underline"
                    onClick={() =>
                      void ws.actions.createClass(label).then((c) => c && ws.actions.mapUnknownLabel(label, c.id))
                    }
                  >
                    Add class
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <label className="mx-2.5 mt-2 flex cursor-pointer items-center justify-between rounded-md bg-panel-2 px-2 py-1.5 text-sm text-fg/90">
        Ask for class after drawing
        <Switch checked={ask} onCheckedChange={(v) => update({ ask_class_after_draw: v })} aria-label="Ask for class after drawing" />
      </label>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ objects

const OBJECT_ROW = 28

function ObjectRow({ box, index }: { box: EditorBox; index: number }) {
  const ws = useWorkspace()
  const bindings = useBindings()
  const selected = useAnnotator((s) => s.selectedIds.includes(box.id))
  const select = useAnnotator((s) => s.select)
  const setHoverId = useAnnotator((s) => s.setHoverId)
  const cls = box.classId !== null ? ws.classById.get(box.classId) : undefined
  const w = Math.round(Math.abs(box.x2 - box.x1))
  const h = Math.round(Math.abs(box.y2 - box.y1))

  function onClick(e: MouseEvent) {
    const cur = useAnnotator.getState().selectedIds
    if (e.shiftKey || e.metaKey || e.ctrlKey) select(cur.includes(box.id) ? cur.filter((id) => id !== box.id) : [...cur, box.id])
    else select([box.id])
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="option"
          aria-selected={selected}
          tabIndex={-1}
          onClick={onClick}
          onDoubleClick={() => ws.canvasRef.current?.revealBox(box.id)}
          onMouseEnter={() => setHoverId(box.id)}
          onMouseLeave={() => setHoverId(null)}
          className={cn(
            'group flex h-full cursor-pointer items-center gap-2 rounded-md px-1.5 text-base',
            selected ? 'bg-accent-soft text-fg' : 'text-fg/85 hover:bg-hover',
            box.hidden && 'opacity-55',
          )}
        >
          <IconButton
            size="xs"
            label={box.hidden ? 'Show box' : 'Hide box'}
            icon={box.hidden ? <EyeOff /> : <Eye />}
            noTooltip
            onClick={(e) => {
              e.stopPropagation()
              ws.actions.toggleHidden([box.id])
            }}
          />
          <span
            className={cn('size-2.5 shrink-0 rounded-[3px]', box.locked && 'ring-1 ring-fg/40')}
            style={{ background: cls?.color ?? UNKNOWN_CLASS_COLOR }}
            aria-hidden
          />
          <span className={cn('min-w-0 truncate', !cls && 'italic text-muted')}>{cls?.name ?? box.rawLabel ?? 'unknown'}</span>
          <span className={cn('shrink-0 text-xs', selected ? 'text-accent-text' : 'text-dim')}>#{index + 1}</span>
          <span className={cn('ml-auto shrink-0 font-mono text-2xs tabular', selected ? 'text-accent-text' : 'text-dim')}>
            {w}×{h}
          </span>
          <span className={cn('flex shrink-0 gap-0.5', !selected && !box.locked && 'hidden group-hover:flex')}>
            <IconButton
              size="xs"
              label={box.locked ? 'Unlock' : 'Lock'}
              icon={box.locked ? <Lock /> : <LockOpen />}
              active={!!box.locked}
              noTooltip
              onClick={(e) => {
                e.stopPropagation()
                ws.actions.toggleLocked([box.id])
              }}
            />
            {ws.editable && (
              <IconButton
                size="xs"
                variant="danger"
                label="Delete box"
                icon={<Trash2 />}
                noTooltip
                disabled={!!box.locked}
                onClick={(e) => {
                  e.stopPropagation()
                  ws.actions.remove([box.id])
                }}
              />
            )}
          </span>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem
          onSelect={() => {
            select([box.id])
            ws.canvasRef.current?.revealBox(box.id)
          }}
        >
          Show on canvas
        </ContextMenuItem>
        <ContextMenuItem shortcut={bindings['box.copy'][0]} onSelect={() => ws.actions.copy([box.id])}>
          Copy
        </ContextMenuItem>
        <ContextMenuItem disabled={!ws.editable} shortcut={bindings['box.duplicate'][0]} onSelect={() => ws.actions.duplicate([box.id])}>
          Duplicate
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => ws.actions.toggleLocked([box.id])}>{box.locked ? 'Unlock' : 'Lock'}</ContextMenuItem>
        <ContextMenuItem onSelect={() => ws.actions.toggleHidden([box.id])}>{box.hidden ? 'Show' : 'Hide'}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem danger disabled={!ws.editable || !!box.locked} onSelect={() => ws.actions.remove([box.id])}>
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function ObjectsSection() {
  const ws = useWorkspace()
  const picker = useAnnotator((s) => s.picker)
  const scrollRef = useRef<HTMLDivElement>(null)
  const boxes = ws.doc.boxes
  const allHidden = boxes.length > 0 && boxes.every((b) => b.hidden)
  const pending = picker?.mode === 'new' ? picker.box : null
  const count = boxes.length + (pending ? 1 : 0)

  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualiser re-renders through its own state
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => OBJECT_ROW,
    overscan: 10,
  })

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    if (boxes.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    const cur = useAnnotator.getState().selectedIds
    const last = cur[cur.length - 1]
    const i = boxes.findIndex((b) => b.id === last)
    const next = e.key === 'ArrowDown' ? Math.min(i + 1, boxes.length - 1) : Math.max(i - 1, 0)
    const id = boxes[next]!.id
    useAnnotator.getState().select([id])
    virtualizer.scrollToIndex(next, { align: 'auto' })
  }

  return (
    <section aria-label="Objects" className="flex min-h-24 flex-1 flex-col border-b border-line">
      <SectionHeader title="Objects" count={boxes.length}>
        {boxes.length > 0 && (
          <IconButton
            size="sm"
            label={allHidden ? 'Show all boxes' : 'Hide all boxes'}
            icon={allHidden ? <EyeOff /> : <Eye />}
            onClick={() => ws.actions.setAllHidden(!allHidden)}
          />
        )}
      </SectionHeader>
      <div
        ref={scrollRef}
        role="listbox"
        aria-label="Objects on this image"
        aria-multiselectable
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 focus-visible:outline-offset-[-2px]"
      >
        {count === 0 ? (
          <p className="px-2 py-3 text-sm text-muted">
            {ws.doc.ready
              ? ws.editable
                ? 'No boxes yet. Press W and drag on the image to draw one.'
                : 'No boxes on this image.'
              : 'Loading…'}
          </p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const box = boxes[v.index]
              return (
                <div
                  key={v.key}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, height: OBJECT_ROW, transform: `translateY(${v.start}px)` }}
                >
                  {box ? (
                    <ObjectRow box={box} index={v.index} />
                  ) : pending ? (
                    <div className="flex h-full items-center gap-2 px-1.5 text-base italic text-muted">
                      <span className="size-[22px]" />
                      <span className="size-2.5 shrink-0 rounded-[3px] border-[1.5px] border-dashed border-accent" aria-hidden />
                      choose a class…
                      <span className="text-xs not-italic text-dim">#{v.index + 1}</span>
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </section>
  )
}

// ------------------------------------------------------------------------------------------------ properties

function PropertiesSection() {
  const ws = useWorkspace()
  const selectedIds = useAnnotator((s) => s.selectedIds)
  const selected = ws.doc.boxes.filter((b) => selectedIds.includes(b.id))
  if (selected.length === 0) return null
  const first = selected[0]!
  const single = selected.length === 1
  const sameClass = selected.every((b) => b.classId === first.classId)
  const cls = first.classId !== null ? ws.classById.get(first.classId) : undefined
  const isVoc = ws.project.label_format === 'voc'
  const disabled = !ws.editable || (single && !!first.locked)
  const index = ws.doc.boxes.findIndex((b) => b.id === first.id)
  const x = Math.min(first.x1, first.x2)
  const y = Math.min(first.y1, first.y2)
  const w = Math.abs(first.x2 - first.x1)
  const h = Math.abs(first.y2 - first.y1)

  return (
    <section aria-label="Properties" className="shrink-0 pb-3">
      <SectionHeader
        title="Properties"
        count={single ? `${cls?.name ?? first.rawLabel ?? 'unknown'} #${index + 1}` : `${selected.length} boxes`}
      />
      <div className="flex flex-col gap-1.5 px-2.5">
        <Select
          aria-label="Class"
          disabled={!ws.editable || ws.classes.length === 0}
          value={sameClass && first.classId !== null ? String(first.classId) : undefined}
          placeholder={sameClass ? (first.rawLabel ? `Unknown: ${first.rawLabel}` : 'Choose a class') : 'Mixed classes'}
          onValueChange={(v) => ws.actions.assignClass(selectedIds, Number(v))}
          items={ws.classes.map((c) => ({
            value: String(c.id),
            label: c.name,
            icon: <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: c.color }} aria-hidden />,
          }))}
        />
        {single && (
          <div className="grid grid-cols-2 gap-1.5">
            <NumberField label="X" value={x} disabled={disabled} onCommit={(v) => ws.actions.updateBox(first.id, { x1: v, x2: v + w })} />
            <NumberField label="Y" value={y} disabled={disabled} onCommit={(v) => ws.actions.updateBox(first.id, { y1: v, y2: v + h })} />
            <NumberField label="W" value={w} min={1} disabled={disabled} onCommit={(v) => ws.actions.updateBox(first.id, { x1: x, x2: x + v })} />
            <NumberField label="H" value={h} min={1} disabled={disabled} onCommit={(v) => ws.actions.updateBox(first.id, { y1: y, y2: y + v })} />
          </div>
        )}
        {isVoc && (
          <div className="mt-1 flex gap-4">
            <CheckboxField
              label="Difficult"
              disabled={!ws.editable}
              checked={selected.every((b) => b.difficult)}
              onCheckedChange={(v) => ws.actions.patchFlags(selectedIds, { difficult: v })}
            />
            <CheckboxField
              label="Truncated"
              disabled={!ws.editable}
              checked={selected.every((b) => b.truncated)}
              onCheckedChange={(v) => ws.actions.patchFlags(selectedIds, { truncated: v })}
            />
          </div>
        )}
      </div>
    </section>
  )
}

export function LabelsTab() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ClassesSection />
      <ObjectsSection />
      <PropertiesSection />
    </div>
  )
}
