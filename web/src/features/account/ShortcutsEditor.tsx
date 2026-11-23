import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Plus, RotateCcw, Search, TriangleAlert, X } from 'lucide-react'
import {
  ACTION_MAP,
  ACTIONS,
  SHORTCUT_GROUPS,
  computeOverrides,
  eventToCombo,
  findConflicts,
  formatCombo,
  type ActionDef,
  type ActionId,
  type Bindings,
} from '@/lib/keymap'
import { cn } from '@/lib/utils'
import { useBindings } from '@/hooks/useBindings'
import { useSettings } from '@/stores/settings'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { Kbd, KeyCap } from '@/components/ui/Kbd'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { SettingsCard } from './SettingsCard'
import { isModified, recordCombo, removeCombo, replaceCombo, resetAction } from './shortcutBindings'

type Issue = { action: ActionId; combo: string } & ({ kind: 'reserved' } | { kind: 'conflict'; other: ActionId })

/** Account → Keyboard shortcuts: press-to-record editor with conflict detection. */
export function ShortcutsEditor() {
  const bindings = useBindings()
  const update = useSettings((s) => s.update)
  const hasOverrides = useSettings((s) => Object.keys(s.settings.shortcuts).length > 0)
  const [recording, setRecording] = useState<ActionId | null>(null)
  const [issue, setIssue] = useState<Issue | null>(null)
  const [query, setQuery] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)

  const conflicts = useMemo(() => [...findConflicts(bindings).entries()], [bindings])

  function save(next: Bindings) {
    update({ shortcuts: computeOverrides(next) })
  }

  function onRecorded(action: ActionId, combo: string) {
    setRecording(null)
    const result = recordCombo(bindings, action, combo)
    if (result.kind === 'added') {
      setIssue(null)
      save(result.next)
    } else if (result.kind === 'unchanged') {
      setIssue(null)
    } else if (result.kind === 'reserved') {
      setIssue({ action, combo, kind: 'reserved' })
    } else {
      setIssue({ action, combo, kind: 'conflict', other: result.other })
    }
  }

  const q = query.trim().toLowerCase()
  const visible = (a: ActionDef) =>
    !q || a.label.toLowerCase().includes(q) || a.id.includes(q) || bindings[a.id].some((c) => formatCombo(c).toLowerCase().includes(q))

  return (
    <div className="flex flex-col gap-5">
      <SettingsCard
        title="Keyboard shortcuts"
        description="Click + and press the keys you want. Changes are saved to your account and apply everywhere."
        actions={
          <Button size="sm" variant="secondary" disabled={!hasOverrides} onClick={() => setConfirmReset(true)}>
            <RotateCcw />
            Reset all
          </Button>
        }
      >
        <ul className="mb-4 grid gap-x-6 gap-y-2.5 rounded-lg border border-line bg-panel-2 p-3 text-sm text-muted sm:grid-cols-2">
          <li className="flex items-start gap-2.5">
            <KeyCap className="mt-px shrink-0">Mod</KeyCap>
            <span>Ctrl on Windows and Linux, ⌘ on macOS.</span>
          </li>
          <li className="flex items-start gap-2.5">
            <Kbd combo="Space" className="mt-px shrink-0" />
            <span>Hold to pan the image temporarily.</span>
          </li>
          <li className="flex items-start gap-2.5">
            <Kbd combo="ArrowUp" className="mt-px shrink-0" />
            <span>Arrow keys nudge selected boxes by 1 px (with Shift by 10 px).</span>
          </li>
          <li className="flex items-start gap-2.5">
            <Kbd combo="Escape" className="mt-px shrink-0" />
            <span>Cancels a gesture or closes a popover.</span>
          </li>
        </ul>

        {conflicts.length > 0 && (
          <div role="alert" className="mb-4 flex gap-2.5 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2.5 text-sm">
            <TriangleAlert className="mt-px size-4 shrink-0 text-warn" aria-hidden />
            <div>
              <div className="font-medium text-fg">Some keys are bound to more than one action</div>
              <ul className="mt-1 space-y-0.5 text-muted">
                {conflicts.map(([combo, ids]) => (
                  <li key={combo} className="flex flex-wrap items-center gap-1.5">
                    <Kbd combo={combo} />
                    {ids.map((id) => ACTION_MAP[id].label).join(' · ')}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <Input
          wrapperClassName="mb-4 max-w-xs"
          size="sm"
          leftIcon={<Search />}
          placeholder="Search actions or keys"
          aria-label="Search shortcuts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="flex flex-col gap-6">
          {SHORTCUT_GROUPS.map((group) => {
            const actions = ACTIONS.filter((a) => a.group === group && visible(a))
            if (actions.length === 0) return null
            return (
              <section key={group} aria-label={group}>
                <h3 className="mb-1 text-2xs font-semibold uppercase tracking-wider text-dim">{group}</h3>
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {actions.map((a) => (
                    <ShortcutRow
                      key={a.id}
                      action={a}
                      combos={bindings[a.id]}
                      modified={isModified(bindings, a.id)}
                      recording={recording === a.id}
                      issue={issue?.action === a.id ? issue : null}
                      onStartRecording={() => {
                        setIssue(null)
                        setRecording(a.id)
                      }}
                      onCancelRecording={() => setRecording(null)}
                      onRecorded={(combo) => onRecorded(a.id, combo)}
                      onRemove={(combo) => save(removeCombo(bindings, a.id, combo))}
                      onReset={() => {
                        setIssue(null)
                        save(resetAction(bindings, a.id))
                      }}
                      onReplace={(combo, other) => {
                        setIssue(null)
                        save(replaceCombo(bindings, a.id, combo, other))
                      }}
                      onDismissIssue={() => setIssue(null)}
                    />
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </SettingsCard>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset all shortcuts?"
        description="Every action goes back to its default keys. Your custom bindings are removed."
        confirmLabel="Reset all"
        danger
        onConfirm={() => update({ shortcuts: {} })}
      />
    </div>
  )
}

interface ShortcutRowProps {
  action: ActionDef
  combos: string[]
  modified: boolean
  recording: boolean
  issue: Issue | null
  onStartRecording: () => void
  onCancelRecording: () => void
  onRecorded: (combo: string) => void
  onRemove: (combo: string) => void
  onReset: () => void
  onReplace: (combo: string, other: ActionId) => void
  onDismissIssue: () => void
}

function ShortcutRow({
  action,
  combos,
  modified,
  recording,
  issue,
  onStartRecording,
  onCancelRecording,
  onRecorded,
  onRemove,
  onReset,
  onReplace,
  onDismissIssue,
}: ShortcutRowProps) {
  const addRef = useRef<HTMLButtonElement | null>(null)

  function refocusAdd() {
    requestAnimationFrame(() => addRef.current?.focus())
  }

  function onRecorderKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    // Capture everything so the global keymap and the browser do not act on it.
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      onCancelRecording()
      refocusAdd()
      return
    }
    const combo = eventToCombo(e.nativeEvent)
    if (!combo) return // bare modifier: keep listening
    onRecorded(combo)
    refocusAdd()
  }

  return (
    <li className={cn('px-3 py-2', recording && 'bg-accent-soft')}>
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-base text-fg">{action.label}</span>
          {modified && (
            <span className="shrink-0 rounded bg-accent-soft px-1.5 text-2xs font-semibold text-accent-text">Custom</span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {combos.length === 0 && !recording && <span className="text-xs text-dim">Not set</span>}
          {combos.map((c) => (
            <span
              key={c}
              className="group/chip inline-flex h-6 items-center gap-1 rounded-md border border-line bg-panel-2 pl-1.5 pr-0.5"
            >
              <Kbd combo={c} />
              <button
                type="button"
                onClick={() => onRemove(c)}
                aria-label={`Remove ${formatCombo(c)} from ${action.label}`}
                className="grid size-4 place-items-center rounded text-dim hover:bg-hover hover:text-danger"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {recording ? (
            <button
              type="button"
              autoFocus
              onKeyDown={onRecorderKeyDown}
              onBlur={onCancelRecording}
              aria-label={`Recording a shortcut for ${action.label}. Press keys, or Escape to cancel.`}
              className="inline-flex h-6 animate-shimmer items-center rounded-md border border-dashed border-accent bg-accent-soft px-2 text-xs font-medium text-accent-text"
            >
              Press keys… (Esc to cancel)
            </button>
          ) : (
            <IconButton
              ref={addRef}
              size="xs"
              variant="outline"
              label={`Add a shortcut for ${action.label}`}
              icon={<Plus />}
              onClick={onStartRecording}
            />
          )}
          <IconButton
            size="xs"
            label={`Reset ${action.label} to default`}
            icon={<RotateCcw />}
            disabled={!modified}
            className={cn(!modified && 'invisible')}
            onClick={onReset}
          />
        </div>
      </div>
      {issue && (
        <div
          role="alert"
          className={cn(
            'mt-1.5 flex flex-wrap items-center gap-2 rounded-md px-2.5 py-1.5 text-sm',
            issue.kind === 'reserved' ? 'bg-danger-soft' : 'bg-warn-soft',
          )}
        >
          <Kbd combo={issue.combo} />
          {issue.kind === 'reserved' ? (
            <span className="text-fg">Reserved by the browser. Choose another combination.</span>
          ) : (
            <>
              <span className="text-fg">
                Already used by <strong className="font-semibold">{ACTION_MAP[issue.other].label}</strong>.
              </span>
              <Button size="xs" variant="secondary" onClick={() => onReplace(issue.combo, issue.other)}>
                Replace
              </Button>
            </>
          )}
          <IconButton size="xs" label="Dismiss" icon={<X />} className="ml-auto" onClick={onDismissIssue} />
        </div>
      )}
    </li>
  )
}
