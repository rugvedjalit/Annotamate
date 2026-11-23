import { useId, useState } from 'react'
import { Plus } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useProjects } from '@/hooks/queries'
import { getProjects } from '@/lib/endpoints'
import { qk } from '@/lib/queryKeys'
import { useSession } from '@/stores/session'
import { naturalCompare } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { EmptyState, ErrorState } from '@/components/ui/Feedback'
import { Switch } from '@/components/ui/Switch'
import { Logo } from '@/components/brand/Logo'
import { ProjectCard, ProjectCardSkeleton } from './ProjectCard'
import { NewProjectDialog } from './NewProjectDialog'

export function ProjectsPage() {
  const user = useSession((s) => s.user)
  const isAdmin = !!user?.is_admin
  const [showArchived, setShowArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const [dialogKey, setDialogKey] = useState(0)
  const switchId = useId()
  const active = useProjects(false)
  const archivedQuery = useQuery({
    queryKey: qk.projects(true),
    queryFn: ({ signal }) => getProjects(true, { signal }),
    enabled: showArchived,
    staleTime: 15_000,
  })

  const projects = (active.data ?? []).filter((p) => !p.archived).sort((a, b) => naturalCompare(a.name, b.name))
  const archived = showArchived
    ? (archivedQuery.data ?? []).filter((p) => p.archived).sort((a, b) => naturalCompare(a.name, b.name))
    : []

  function openCreate() {
    setDialogKey((k) => k + 1)
    setCreating(true)
  }

  return (
    <div className="mx-auto w-full max-w-[1320px] px-6 py-7">
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-baseline gap-2 text-lg font-semibold tracking-tight text-fg">
            Projects
            {active.data && <span className="text-base font-normal text-dim tabular-nums">{projects.length}</span>}
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            {isAdmin ? 'Every project on this server.' : 'Projects you are a member of.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Switch id={switchId} checked={showArchived} onCheckedChange={setShowArchived} />
          <label htmlFor={switchId} className="cursor-pointer select-none text-sm text-muted">
            Show archived
          </label>
        </div>
        {isAdmin && (
          <Button variant="primary" onClick={openCreate}>
            <Plus />
            New project
          </Button>
        )}
      </div>

      {active.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading projects">
          {Array.from({ length: 6 }, (_, i) => (
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      ) : active.isError ? (
        <ErrorState title="Could not load projects" error={active.error} onRetry={() => void active.refetch()} />
      ) : projects.length === 0 ? (
        <EmptyState
          className="rounded-xl border border-dashed border-line bg-panel/50 py-16"
          icon={<Logo variant="mark" height={28} />}
          title={isAdmin ? 'Create your first project' : 'No projects yet'}
          description={
            isAdmin
              ? 'Point a project at an image folder on this server, choose a label format and invite your team.'
              : 'Ask an administrator to add you to a project. It will appear here right away.'
          }
          action={
            isAdmin ? (
              <Button variant="primary" onClick={openCreate}>
                <Plus />
                New project
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}

      {showArchived && (
        <section className="mt-10" aria-labelledby="archived-heading">
          <h2 id="archived-heading" className="mb-3 flex items-baseline gap-2 text-md font-semibold text-muted">
            Archived
            {archivedQuery.data && <span className="text-sm font-normal text-dim">{archived.length}</span>}
          </h2>
          {archivedQuery.isPending ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 3 }, (_, i) => (
                <ProjectCardSkeleton key={i} />
              ))}
            </div>
          ) : archivedQuery.isError ? (
            <ErrorState compact title="Could not load archived projects" error={archivedQuery.error} onRetry={() => void archivedQuery.refetch()} />
          ) : archived.length === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
              No archived projects.
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {archived.map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          )}
        </section>
      )}

      {isAdmin && <NewProjectDialog key={dialogKey} open={creating} onOpenChange={setCreating} />}
    </div>
  )
}
