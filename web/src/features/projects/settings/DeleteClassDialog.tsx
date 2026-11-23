import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, GitMerge, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { deleteClass, getProject } from '@/lib/endpoints'
import { ApiError, errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import type { ClassDeleteStrategy, LabelFormat, ProjectClass } from '@/lib/types'
import { formatNumber } from '@/lib/format'
import { pluralize } from '@/lib/utils'
import { useProject } from '@/hooks/queries'
import { useRealtime, type ClassMigrationProgress } from '@/stores/realtime'
import { invalidateAfterClassMigration } from '@/app/classMigrationEvents'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Progress } from '@/components/ui/Feedback'
import { Select } from '@/components/ui/Select'
import { RadioCards } from '../RadioCards'
import { classMigrationPercent, useClassMigration } from '../useClassMigration'

interface DeleteClassDialogProps {
  projectId: number
  cls: ProjectClass
  classes: ProjectClass[]
  format: LabelFormat
  /** From stats, when known. */
  usage: { boxes: number; images: number } | undefined
  onOpenChange: (open: boolean) => void
}

/** Without progress events: how often the project is asked whether the job still runs. */
const POLL_MS = 2000
/** The final event usually arrives right after the project stops reporting the job: give it this long. */
const FINAL_EVENT_GRACE_MS = 1500

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Delete a class with an explicit strategy: only if unused, delete its boxes, or merge into another class.
 * The server answers at once and rewrites the label files in the background: the dialog then shows the
 * progress. It may be closed meanwhile; the result toast comes from the realtime bridge either way.
 */
export function DeleteClassDialog({ projectId, cls, classes, format, usage, onOpenChange }: DeleteClassDialogProps) {
  const qc = useQueryClient()
  const others = classes.filter((c) => c.id !== cls.id)
  const knownUsed = (usage?.boxes ?? 0) > 0
  const fallbackStrategy: ClassDeleteStrategy = others.length ? 'merge' : 'delete_boxes'
  const [strategy, setStrategy] = useState<ClassDeleteStrategy>(knownUsed ? fallbackStrategy : 'forbid')
  const [mergeInto, setMergeInto] = useState<string | undefined>(others[0] ? String(others[0].id) : undefined)
  const [inUse, setInUse] = useState<number | null>(null)
  /** 'running' from the 202 until the job's final event (or until the project no longer reports the job). */
  const [phase, setPhase] = useState<'form' | 'running'>('form')
  const [succeeded, setSucceeded] = useState(false)
  const [handled, setHandled] = useState<ClassMigrationProgress | null>(null)

  const project = useProject(projectId).data
  const migration = useClassMigration({ id: projectId, class_migration: project?.class_migration ?? null })
  const live = useRealtime((s) => s.classMigration[projectId])
  const target = others.find((c) => String(c.id) === mergeInto)

  const mutation = useMutation({
    mutationFn: () => {
      // Registered before the request: the job's events can arrive before the HTTP response does.
      const store = useRealtime.getState()
      store.setClassMigration(projectId, null)
      store.setClassMigrationStarted(projectId, {
        className: cls.name,
        mergeIntoName: strategy === 'merge' ? (target?.name ?? null) : null,
        dialogOpen: true,
      })
      return deleteClass(projectId, cls.id, strategy, strategy === 'merge' ? Number(mergeInto) : undefined)
    },
    onSuccess: () => {
      setInUse(null)
      setPhase('running')
    },
    onError: (err) => {
      useRealtime.getState().setClassMigrationStarted(projectId, null)
      if (err instanceof ApiError && err.code === 'in_use') {
        const n = typeof err.extra.images === 'number' ? err.extra.images : null
        setInUse(n ?? 0)
        if (strategy === 'forbid') setStrategy(fallbackStrategy)
        return
      }
      if (err instanceof ApiError && err.code === 'migrating') void qc.invalidateQueries({ queryKey: qk.project(projectId) })
      toast.error('Could not delete the class', { description: errorMessage(err) })
    },
  })

  // The job's final event (kept in the store for a few seconds). State is adjusted while rendering.
  if (phase === 'running' && live?.finished && live !== handled) {
    setHandled(live)
    setPhase('form')
    if (live.error === undefined) {
      setSucceeded(true) // the toast is shown by the realtime bridge
    } else if (live.code === 'in_use') {
      // The index said "unused" but the label files did not: same warning as the synchronous refusal.
      setInUse(live.images ?? 0)
      if (strategy === 'forbid') setStrategy(fallbackStrategy)
    }
    // Other failures: the bridge showed the error; the form is back for another try.
  }

  useEffect(() => {
    if (succeeded) onOpenChange(false)
  }, [succeeded, onOpenChange])

  // The dialog was closed while the job runs: the bridge then reports every outcome as a toast.
  useEffect(
    () => () => {
      const store = useRealtime.getState()
      const mine = store.classMigrationStarted[projectId]
      if (mine?.dialogOpen) store.setClassMigrationStarted(projectId, { ...mine, dialogOpen: false })
    },
    [projectId],
  )

  // No events (yet, or the connection dropped): ask the project until it no longer reports the job, so
  // the dialog never hangs. Whether the class still exists then tells success from failure.
  const waitingWithoutEvents = phase === 'running' && !live
  useEffect(() => {
    if (!waitingWithoutEvents) return
    let stopped = false
    void (async () => {
      while (!stopped) {
        try {
          const fresh = await qc.fetchQuery({
            queryKey: qk.project(projectId),
            queryFn: ({ signal }) => getProject(projectId, { signal }),
            staleTime: 0,
          })
          if (stopped) return
          if (!fresh.class_migration) {
            await wait(FINAL_EVENT_GRACE_MS)
            if (stopped) return
            const store = useRealtime.getState()
            const mine = store.classMigrationStarted[projectId]
            store.setClassMigrationStarted(projectId, null)
            invalidateAfterClassMigration(qc, projectId)
            if (fresh.classes.some((c) => c.id === cls.id)) {
              if (mine) {
                toast.error('Could not delete the class', {
                  description: 'The change did not complete and the class was kept. See the project activity for details.',
                })
              }
              setPhase('form')
            } else {
              if (mine) {
                toast.success(
                  mine.mergeIntoName ? `Merged “${mine.className}” into “${mine.mergeIntoName}”` : `Deleted class “${mine.className}”`,
                )
              }
              setSucceeded(true)
            }
            return
          }
        } catch {
          // offline or a server error: ask again
        }
        await wait(POLL_MS)
      }
    })()
    return () => {
      stopped = true
    }
  }, [waitingWithoutEvents, qc, projectId, cls.id])

  const running = phase === 'running'
  const requesting = mutation.isPending
  /** Another class change (someone else's, or one started earlier) is still rewriting label files. */
  const blocked = !running && !requesting && !!migration
  const kind = migration?.kind ?? (strategy === 'merge' ? 'merge' : 'delete')
  const percent = migration ? classMigrationPercent(migration) : null
  const canSubmit = strategy !== 'merge' || !!mergeInto

  return (
    <Dialog open onOpenChange={(o) => !requesting && onOpenChange(o)}>
      <DialogContent
        size="md"
        title={
          <span className="flex items-center gap-2">
            Delete class
            <span className="inline-flex items-center gap-1.5 rounded-md bg-panel-2 px-2 py-0.5 text-base font-medium">
              <span className="size-2.5 rounded-sm" style={{ background: cls.color }} aria-hidden />
              {cls.name}
            </span>
          </span>
        }
        description={
          usage
            ? usage.boxes > 0
              ? `Used by ${pluralize(usage.boxes, 'box', 'boxes')} in ${pluralize(usage.images, 'image')}.`
              : 'No boxes use this class.'
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={requesting}>
              {running ? 'Close' : 'Cancel'}
            </Button>
            <Button variant="danger" loading={requesting || running} disabled={!canSubmit || blocked} onClick={() => mutation.mutate()}>
              {strategy === 'merge' ? 'Merge and delete' : 'Delete class'}
            </Button>
          </>
        }
      >
        {running ? (
          <div role="status" aria-live="polite" className="flex flex-col gap-2.5 py-2">
            <div className="flex items-baseline gap-2 text-base text-fg">
              <span className="font-medium">
                {kind === 'merge' ? 'Merging class…' : 'Removing class…'}
                {percent ? ` ${percent}` : ''}
              </span>
              {migration && migration.total > 0 && (
                <span className="ml-auto text-xs tabular-nums text-muted">
                  {formatNumber(migration.done)} of {pluralize(migration.total, 'label file')}
                </span>
              )}
            </div>
            {migration && migration.total > 0 ? (
              <Progress value={(migration.done / migration.total) * 100} label="Class change progress" />
            ) : (
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-hover" aria-hidden>
                <div className="h-full w-1/3 animate-shimmer rounded-full bg-accent" />
              </div>
            )}
            <p className="text-xs text-muted">
              Label files are being rewritten and editing is paused in this project. You can close this dialog: the change
              continues in the background.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {blocked && (
              <p role="status" className="rounded-md border border-line bg-panel-2 px-3 py-2 text-sm text-muted">
                Another class change is running in this project. Wait until it has finished.
              </p>
            )}
            {inUse !== null && (
              <div role="alert" className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-fg">
                <CircleAlert className="mt-px size-4 shrink-0 text-warn" aria-hidden />
                <span>
                  “{cls.name}” is still used{inUse > 0 ? ` in ${formatNumber(inUse)} ${inUse === 1 ? 'image' : 'images'}` : ''}. Choose
                  whether to delete those boxes or merge them into another class.
                </span>
              </div>
            )}
            <RadioCards
              aria-label="What happens to boxes of this class"
              value={strategy}
              onValueChange={setStrategy}
              options={[
                {
                  value: 'forbid',
                  icon: <ShieldCheck className="size-4 text-muted" />,
                  title: 'Only if unused',
                  description: 'Safe: the server refuses if any label still uses this class.',
                },
                {
                  value: 'merge',
                  icon: <GitMerge className="size-4 text-muted" />,
                  title: 'Merge into another class',
                  description: 'Every box of this class is relabelled.',
                  disabled: others.length === 0,
                },
                {
                  value: 'delete_boxes',
                  icon: <Trash2 className="size-4 text-danger" />,
                  title: 'Delete its boxes',
                  description: 'Removes every box of this class from all label files. This cannot be undone.',
                },
              ]}
            />
            {strategy === 'merge' && (
              <Select
                aria-label="Merge into"
                value={mergeInto}
                onValueChange={setMergeInto}
                placeholder="Choose a class"
                items={others.map((c) => ({
                  value: String(c.id),
                  label: c.name,
                  icon: <span className="size-2.5 shrink-0 rounded-sm" style={{ background: c.color }} />,
                }))}
              />
            )}
            {format === 'yolo' && (
              <p className="text-xs text-muted">
                YOLO stores class positions: classes after #{cls.index} move up by one, and label files are rewritten
                automatically to match.
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
