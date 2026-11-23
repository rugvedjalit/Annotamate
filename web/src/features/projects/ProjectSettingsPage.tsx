import { Link, NavLink, Navigate, useParams } from 'react-router'
import { GitBranch, Settings2, ShieldAlert, Tag, TriangleAlert, Users } from 'lucide-react'
import { useProjectContext } from '@/app/projectContext'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/Feedback'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { isSettingsTab, type SettingsTab } from './projectUtils'
import { GeneralTab } from './settings/GeneralTab'
import { ClassesTab } from './settings/ClassesTab'
import { MembersTab } from './settings/MembersTab'
import { WorkflowTab } from './settings/WorkflowTab'
import { DangerZoneTab } from './settings/DangerZoneTab'

const TABS: { id: SettingsTab; label: string; icon: typeof Tag }[] = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'classes', label: 'Classes', icon: Tag },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'workflow', label: 'Workflow', icon: GitBranch },
  { id: 'danger', label: 'Danger zone', icon: TriangleAlert },
]

export function ProjectSettingsPage() {
  const { projectId, project } = useProjectContext()
  const { tab } = useParams()

  if (!project.permissions.can_manage) {
    return (
      <EmptyState
        className="h-full"
        icon={<ShieldAlert />}
        title="Managers only"
        description="Ask a project manager if something needs to change in this project's settings."
        action={
          <Button asChild variant="secondary">
            <Link to={`/p/${projectId}`}>Back to the overview</Link>
          </Button>
        }
      />
    )
  }
  if (tab !== undefined && !isSettingsTab(tab)) return <Navigate to={`/p/${projectId}/settings`} replace />
  const active: SettingsTab = tab ?? 'general'

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-6 py-6 md:flex-row">
      <nav aria-label="Settings sections" className="shrink-0 md:w-52">
        <h1 className="mb-3 px-2 text-lg font-semibold tracking-tight text-fg">Settings</h1>
        <ul className="flex gap-1 overflow-x-auto md:flex-col">
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <li key={t.id}>
                <NavLink
                  to={`/p/${projectId}/settings/${t.id}`}
                  aria-current={active === t.id ? 'page' : undefined}
                  className={cn(
                    'flex h-8 items-center gap-2 whitespace-nowrap rounded-md px-2.5 text-base transition-colors',
                    active === t.id ? 'bg-hover font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg',
                    t.id === 'danger' && active !== t.id && 'hover:text-danger',
                  )}
                >
                  <Icon className={cn('size-4', t.id === 'danger' && 'text-danger')} aria-hidden />
                  {t.label}
                </NavLink>
              </li>
            )
          })}
        </ul>
      </nav>
      <div className="min-w-0 flex-1">
        <ErrorBoundary name="Settings" resetKey={active}>
          {active === 'general' && <GeneralTab key={project.id} project={project} />}
          {active === 'classes' && <ClassesTab project={project} />}
          {active === 'members' && <MembersTab project={project} />}
          {active === 'workflow' && <WorkflowTab project={project} />}
          {active === 'danger' && <DangerZoneTab project={project} />}
        </ErrorBoundary>
      </div>
    </div>
  )
}
