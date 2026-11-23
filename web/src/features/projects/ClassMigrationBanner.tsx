import type { ProjectSummary } from '@/lib/types'
import { Progress, Spinner } from '@/components/ui/Feedback'
import { classMigrationPercent, useClassMigration } from './useClassMigration'

/** Non-blocking notice on the project pages while a class delete/merge rewrites label files. */
export function ClassMigrationBanner({ project }: { project: Pick<ProjectSummary, 'id' | 'class_migration'> }) {
  const migration = useClassMigration(project)
  if (!migration) return null
  const percent = classMigrationPercent(migration)
  return (
    <div role="status" className="flex shrink-0 flex-col gap-1.5 border-b border-accent/30 bg-accent-soft px-4 py-2 text-sm">
      <div className="flex items-center gap-2 text-fg">
        <Spinner className="size-3.5 text-accent-text" label="Class change" />
        <span className="font-medium">Class change in progress – editing is paused</span>
        <span className="hidden min-w-0 truncate text-muted sm:inline">
          {migration.kind === 'merge' ? 'Merging' : 'Removing'} “{migration.class_name}” in the label files.
        </span>
        {percent && <span className="ml-auto tabular-nums text-muted">{percent}</span>}
      </div>
      {percent && <Progress value={(migration.done / migration.total) * 100} className="h-1" label="Class change progress" />}
    </div>
  )
}
