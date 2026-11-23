// Applies `classes.migration` events (background class delete/merge) to the realtime store and the query
// caches, and shows the result toast for a change started in this tab (the dialog may be closed by then).
import type { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { patchProject } from '@/lib/cacheUpdates'
import { qk } from '@/lib/queryKeys'
import type { ServerMessageMap } from '@/lib/types'
import { pluralize } from '@/lib/utils'
import { useRealtime, type ClassMigrationProgress } from '@/stores/realtime'

/** How long the final event stays in the store (the delete dialog reads its result from there). */
export const CLASS_MIGRATION_LINGER_MS = 4000

/** Everything that depends on label files or classes: refetched (or marked stale) when a migration ends. */
export function invalidateAfterClassMigration(qc: QueryClient, projectId: number): void {
  for (const key of [
    qk.project(projectId),
    qk.projectsAll,
    qk.stats(projectId),
    qk.imagesAll(projectId),
    qk.neighborsAll(projectId),
    qk.activityAll(projectId),
    ['project', projectId, 'image'],
    // Annotation documents have no observers: they are marked stale, open annotators reload theirs.
    qk.annotationsAll(projectId),
  ]) {
    void qc.invalidateQueries({ queryKey: key })
  }
}

export function applyClassMigrationEvent(qc: QueryClient, m: ServerMessageMap['classes.migration']): void {
  const pid = m.project_id
  const store = useRealtime.getState()
  const progress: ClassMigrationProgress = {
    kind: m.kind,
    class_name: m.class_name,
    done: m.done,
    total: m.total,
    finished: m.finished,
    error: m.error,
    code: m.code,
    images: m.images,
    rewritten_files: m.rewritten_files,
  }
  store.setClassMigration(pid, progress)
  patchProject(qc, pid, () => ({
    class_migration: m.finished ? null : { kind: m.kind, class_name: m.class_name, done: m.done, total: m.total },
  }))
  if (!m.finished) return

  invalidateAfterClassMigration(qc, pid)

  const started = store.classMigrationStarted[pid]
  if (started) {
    store.setClassMigrationStarted(pid, null)
    if (m.error === undefined) {
      toast.success(
        m.kind === 'merge' && started.mergeIntoName
          ? `Merged “${started.className}” into “${started.mergeIntoName}”`
          : `Deleted class “${started.className}”`,
        { description: m.rewritten_files ? `${pluralize(m.rewritten_files, 'label file')} rewritten.` : undefined },
      )
    } else if (!(m.code === 'in_use' && started.dialogOpen)) {
      // An "in use" refusal is shown inside the dialog while it is open.
      toast.error('Could not delete the class', { description: m.error })
    }
  }

  setTimeout(() => {
    const s = useRealtime.getState()
    // A newer migration of the same project keeps its own entry.
    if (s.classMigration[pid] === progress) s.setClassMigration(pid, null)
  }, CLASS_MIGRATION_LINGER_MS)
}
