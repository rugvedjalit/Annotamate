import { Suspense, useEffect } from 'react'
import { Link, NavLink, Outlet, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { FolderX } from 'lucide-react'
import { getMySettings } from '@/lib/endpoints'
import { qk } from '@/lib/queryKeys'
import { isApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useProject } from '@/hooks/queries'
import { useShortcuts, useKeymapListener } from '@/hooks/useShortcuts'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { realtime, useRealtime } from '@/stores/realtime'
import { ProjectContext } from './projectContext'
import { RealtimeBridge } from './RealtimeBridge'
import { TopBar } from '@/components/TopBar'
import { ConnectionBanner } from '@/components/ConnectionBanner'
import { CommandPalette } from '@/components/CommandPalette'
import { ShortcutsDialog } from '@/components/ShortcutsDialog'
import { AboutDialog } from '@/components/AboutDialog'
import { ProjectSwitcher } from '@/components/ProjectSwitcher'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Button } from '@/components/ui/Button'
import { EmptyState, ErrorState, LoadingBlock, Skeleton } from '@/components/ui/Feedback'
import { ChatDrawer } from '@/features/chat/ChatDrawer'
import { ClassMigrationBanner } from '@/features/projects/ClassMigrationBanner'

/** Everything behind sign-in: realtime connection, settings, global shortcuts and dialogs. */
export function AuthedLayout() {
  useKeymapListener()
  const settingsQuery = useQuery({ queryKey: qk.settings, queryFn: ({ signal }) => getMySettings({ signal }), staleTime: Infinity })
  const loadSettings = useSettings((s) => s.load)
  useEffect(() => {
    if (settingsQuery.data) loadSettings(settingsQuery.data)
  }, [settingsQuery.data, loadSettings])

  const setPaletteOpen = useUi((s) => s.setPaletteOpen)
  const setShortcutsOpen = useUi((s) => s.setShortcutsOpen)
  const toggleChat = useUi((s) => s.toggleChat)
  useShortcuts('global', {
    palette: () => setPaletteOpen(!useUi.getState().paletteOpen),
    help: () => setShortcutsOpen(true),
    'chat.toggle': () => {
      if (useUi.getState().currentProjectId === null) return false
      toggleChat()
    },
  })

  return (
    <>
      <RealtimeBridge />
      <Suspense fallback={<LoadingBlock className="h-full" />}>
        <Outlet />
      </Suspense>
      <CommandPalette />
      <ShortcutsDialog />
      <AboutDialog />
    </>
  )
}

/** Pages outside a project: top bar + scrolling content. */
export function AppShell() {
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <ConnectionBanner />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <ErrorBoundary name="This page">
          <Suspense fallback={<LoadingBlock className="h-full" />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  )
}

/** Loads the project, joins its realtime room and hosts the chat drawer for every project page. */
export function ProjectLayout() {
  const params = useParams()
  const projectId = Number(params.projectId)
  const query = useProject(projectId)
  const setCurrentProjectId = useUi((s) => s.setCurrentProjectId)
  const setChatOpen = useUi((s) => s.setChatOpen)

  useEffect(() => {
    if (!Number.isFinite(projectId)) return
    setCurrentProjectId(projectId)
    realtime.subscribeProject(projectId)
    return () => {
      setCurrentProjectId(null)
      setChatOpen(false)
      realtime.subscribeProject(null)
      useRealtime.getState().clearProject()
    }
  }, [projectId, setCurrentProjectId, setChatOpen])

  if (!Number.isFinite(projectId) || (query.isError && isApiError(query.error, 'not_found'))) {
    return (
      <div className="flex h-full flex-col">
        <TopBar />
        <EmptyState
          className="flex-1"
          icon={<FolderX />}
          title="Project not found"
          description="It may have been deleted, or you are not a member of it."
          action={
            <Button asChild variant="secondary">
              <Link to="/">Back to projects</Link>
            </Button>
          }
        />
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className="flex h-full flex-col">
        <TopBar />
        <ErrorState className="flex-1" title="Could not load the project" error={query.error} onRetry={() => void query.refetch()} />
      </div>
    )
  }
  if (query.isPending) {
    return (
      <div className="flex h-full flex-col">
        <TopBar left={<Skeleton className="h-6 w-48" />} />
        <LoadingBlock className="flex-1" />
      </div>
    )
  }
  return (
    <ProjectContext.Provider value={{ projectId, project: query.data }}>
      <Suspense fallback={<LoadingBlock className="h-full" />}>
        <Outlet />
      </Suspense>
      <ErrorBoundary name="Chat" className="fixed right-0 top-12 w-[360px]">
        <ChatDrawer />
      </ErrorBoundary>
    </ProjectContext.Provider>
  )
}

function ProjectTab({ to, end, children }: { to: string; end?: boolean; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'relative flex h-[30px] items-center rounded-md px-2.5 text-sm font-medium transition-colors',
          isActive ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-fg',
        )
      }
    >
      {children}
    </NavLink>
  )
}

/** Project pages other than the annotator: project switcher + section tabs. */
export function ProjectShell() {
  const params = useParams()
  const projectId = Number(params.projectId)
  const query = useProject(projectId)
  const project = query.data
  if (!project) return null
  const base = `/p/${projectId}`
  return (
    <div className="flex h-full flex-col">
      <TopBar
        left={
          <>
            <ProjectSwitcher project={project} />
            <nav aria-label="Project sections" className="ml-1 hidden items-center gap-0.5 md:flex">
              <ProjectTab to={base} end>
                Overview
              </ProjectTab>
              <ProjectTab to={`${base}/images`}>Images</ProjectTab>
              <ProjectTab to={`${base}/annotate`}>Annotate</ProjectTab>
              {project.permissions.can_manage && <ProjectTab to={`${base}/settings`}>Settings</ProjectTab>}
            </nav>
          </>
        }
      />
      <ConnectionBanner />
      <ClassMigrationBanner project={project} />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <ErrorBoundary name="This page" resetKey={projectId}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  )
}
