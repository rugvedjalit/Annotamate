import { CircleAlert, GitMerge, LoaderCircle, Lock } from 'lucide-react'
import { useBindings } from '@/hooks/useBindings'
import { useSettings } from '@/stores/settings'
import { Tooltip } from '@/components/ui/Tooltip'
import { formatCombo } from '@/lib/keymap'
import { cn } from '@/lib/utils'
import { useWorkspace } from './workspaceContext'

/** Always-visible save state: Saved / Unsaved / Saving / Save failed / Conflict / Read-only. */
export function SavePill() {
  const ws = useWorkspace()
  const autosave = useSettings((s) => s.settings.autosave)
  const saveCombo = useBindings().save[0]
  const st = ws.doc.state
  if (!ws.doc.ready) return null

  const base = 'inline-flex h-[26px] items-center gap-1.5 rounded-full px-2.5 text-sm font-medium whitespace-nowrap'

  if (st.save === 'conflict') {
    return (
      <span role="status" className={cn(base, 'bg-danger-soft text-danger')}>
        <GitMerge className="size-3.5" aria-hidden />
        Conflict
      </span>
    )
  }
  if (st.save === 'error') {
    return (
      <Tooltip content={st.saveError ?? 'Saving failed'}>
        <button
          type="button"
          onClick={() => void ws.doc.save()}
          className={cn(base, 'bg-danger-soft text-danger hover:brightness-110')}
          aria-label={`Save failed: ${st.saveError ?? ''}. Retry`}
        >
          <CircleAlert className="size-3.5" aria-hidden />
          Save failed · Retry
        </button>
      </Tooltip>
    )
  }
  if (st.save === 'saving') {
    return (
      <span role="status" aria-live="polite" className={cn(base, 'bg-accent-soft text-accent-text')}>
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        Saving…
      </span>
    )
  }
  if (st.dirty) {
    if (!ws.editable) {
      return (
        <Tooltip content="These changes cannot be saved right now; they are kept in this tab.">
          <span role="status" className={cn(base, 'bg-warn-soft text-warn')}>
            <Lock className="size-3.5" aria-hidden />
            Unsaved (read-only)
          </span>
        </Tooltip>
      )
    }
    return (
      <Tooltip content={autosave ? 'Saving shortly…' : 'Autosave is off'} shortcut={saveCombo}>
        <button
          type="button"
          onClick={() => void ws.doc.save()}
          className={cn(base, 'bg-warn-soft text-warn hover:brightness-110')}
        >
          <span className="size-[7px] rounded-full bg-current" aria-hidden />
          {autosave ? 'Unsaved' : `Unsaved · ${saveCombo ? formatCombo(saveCombo) : 'save'}`}
        </button>
      </Tooltip>
    )
  }
  if (ws.readOnly && ws.readOnly.kind !== 'acquiring') {
    return (
      <span role="status" className={cn(base, 'bg-hover text-muted')}>
        <Lock className="size-3.5" aria-hidden />
        Read-only
      </span>
    )
  }
  return (
    <span role="status" aria-live="polite" className={cn(base, 'bg-ok-soft text-ok')}>
      <span className="size-[7px] rounded-full bg-current" aria-hidden />
      Saved
    </span>
  )
}
