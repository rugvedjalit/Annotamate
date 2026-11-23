import { useEffect, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import type { ImageFilters } from '@/lib/filters'
import { hasActiveFilters } from '@/lib/filters'
import type { ImageStatus, Member, ProjectClass } from '@/lib/types'
import { IMAGE_STATUSES } from '@/lib/types'
import { STATUS_META } from '@/lib/status'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Button } from '@/components/ui/Button'
import { StatusIcon } from '@/components/StatusIcon'
import { useDebounced } from '../viewHooks'

interface ImageFiltersBarProps {
  filters: ImageFilters
  onChange: (next: ImageFilters) => void
  members: Member[]
  classes: ProjectClass[]
  total: number | undefined
}

const chip =
  'inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-sm transition-colors [&_svg]:size-3.5'

/** One row of filters above the table; everything is mirrored into the URL by the page. */
export function ImageFiltersBar({ filters, onChange, members, classes, total }: ImageFiltersBarProps) {
  const [q, setQ] = useState(filters.q ?? '')
  const [prevQ, setPrevQ] = useState(filters.q ?? '')
  if ((filters.q ?? '') !== prevQ) {
    // The URL changed from elsewhere (clear button, back/forward): follow it.
    setPrevQ(filters.q ?? '')
    setQ(filters.q ?? '')
  }
  const debounced = useDebounced(q, 300)
  const latest = useRef({ filters, onChange })
  useEffect(() => {
    latest.current = { filters, onChange }
  })
  // Only typing (the debounced text) submits the search; other filter changes must not re-submit it.
  useEffect(() => {
    const { filters: f, onChange: change } = latest.current
    if (debounced.trim() !== (f.q ?? '').trim()) change({ ...f, q: debounced.trim() || undefined })
  }, [debounced])

  const statuses = new Set(filters.status ?? [])
  function toggleStatus(s: ImageStatus) {
    const next = new Set(statuses)
    if (next.has(s)) next.delete(s)
    else next.add(s)
    onChange({ ...filters, status: next.size ? IMAGE_STATUSES.filter((x) => next.has(x)) : undefined })
  }

  const assigneeValue = filters.assignee === undefined ? 'any' : typeof filters.assignee === 'number' ? `u${filters.assignee}` : filters.assignee
  const active = hasActiveFilters(filters)

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Search file names"
          leftIcon={<Search />}
          placeholder={total !== undefined ? `Search ${total.toLocaleString()} files` : 'Search files'}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          wrapperClassName="w-64"
          rightSlot={
            q ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQ('')}
                className="grid size-6 place-items-center rounded text-dim hover:bg-hover hover:text-fg"
              >
                <X className="size-3.5" />
              </button>
            ) : undefined
          }
        />
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Status">
          {IMAGE_STATUSES.map((s) => {
            const on = statuses.has(s)
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => toggleStatus(s)}
                className={cn(
                  chip,
                  on
                    ? 'border-accent/50 bg-accent-soft text-fg'
                    : 'border-line bg-panel-2 text-muted hover:border-line-strong hover:text-fg',
                )}
              >
                <StatusIcon status={s} />
                {STATUS_META[s].label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Assignee"
          size="sm"
          className="w-44"
          value={assigneeValue}
          onValueChange={(v) =>
            onChange({
              ...filters,
              assignee: v === 'any' ? undefined : v === 'me' || v === 'none' ? v : Number(v.slice(1)),
            })
          }
          items={[
            { value: 'any', label: 'Anyone' },
            { value: 'me', label: 'Assigned to me' },
            { value: 'none', label: 'Unassigned' },
            ...members.map((m) => ({ value: `u${m.user.id}`, label: m.user.display_name })),
          ]}
        />
        <Select
          aria-label="Flag"
          size="sm"
          className="w-36"
          value={filters.flagged === undefined ? 'any' : filters.flagged ? 'true' : 'false'}
          onValueChange={(v) => onChange({ ...filters, flagged: v === 'any' ? undefined : v === 'true' })}
          items={[
            { value: 'any', label: 'Flagged or not' },
            { value: 'true', label: 'Flagged' },
            { value: 'false', label: 'Not flagged' },
          ]}
        />
        <Select
          aria-label="Class"
          size="sm"
          className="w-44"
          value={filters.class_id === undefined ? 'any' : String(filters.class_id)}
          onValueChange={(v) => onChange({ ...filters, class_id: v === 'any' ? undefined : Number(v) })}
          items={[
            { value: 'any', label: 'Any class' },
            ...classes.map((c) => ({
              value: String(c.id),
              label: c.name,
              icon: <span className="size-2.5 shrink-0 rounded-sm" style={{ background: c.color }} />,
            })),
          ]}
        />
        <Select
          aria-label="Comments"
          size="sm"
          className="w-56"
          value={filters.has_comments ?? 'all'}
          onValueChange={(v) => onChange({ ...filters, has_comments: v === 'all' ? undefined : v })}
          items={[
            { value: 'all', label: 'With or without comments' },
            { value: 'open', label: 'Has open comments' },
            { value: 'any', label: 'Has any comments' },
          ]}
        />
        <Select
          aria-label="Sort"
          size="sm"
          className="w-44"
          value={filters.sort ?? 'name'}
          onValueChange={(v) => onChange({ ...filters, sort: v === 'name' ? undefined : v })}
          items={[
            { value: 'name', label: 'Name (natural)' },
            { value: 'updated', label: 'Recently updated' },
          ]}
        />
        {active && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setQ('')
              onChange({ sort: filters.sort })
            }}
          >
            <X />
            Clear filters
          </Button>
        )}
      </div>
    </div>
  )
}
