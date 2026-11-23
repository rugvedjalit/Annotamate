import type { ClassMigration, ProjectSummary } from '@/lib/types'
import { formatPercent } from '@/lib/format'
import { useRealtime } from '@/stores/realtime'

/**
 * The class delete/merge running in a project, or null. Live progress from the WebSocket wins over the
 * project query (which the realtime bridge keeps patched as well).
 */
export function useClassMigration(project: Pick<ProjectSummary, 'id' | 'class_migration'>): ClassMigration | null {
  const live = useRealtime((s) => s.classMigration[project.id])
  if (live) return live.finished ? null : live
  return project.class_migration ?? null
}

/** "42%" once the number of label files is known. */
export function classMigrationPercent(m: Pick<ClassMigration, 'done' | 'total'>): string | null {
  return m.total > 0 ? formatPercent(m.done, m.total) : null
}

export const CLASS_MIGRATION_HINT = 'A class change is in progress. Editing is paused until it finishes.'
