import { useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useMutation } from '@tanstack/react-query'
import { Images, PenTool, RefreshCw, Search, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { rescanProject } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { ROLE_LABELS } from '@/lib/status'
import { formatNumber } from '@/lib/format'
import { useProjectContext } from '@/app/projectContext'
import { useRealtime } from '@/stores/realtime'
import { useUi } from '@/stores/ui'
import { Button } from '@/components/ui/Button'
import { Badge, FormatBadge } from '@/components/ui/Badge'
import { ErrorState, Skeleton } from '@/components/ui/Feedback'
import { ActivityFeed } from '@/features/activity/ActivityFeed'
import { StatusBar, StatusLegend } from './StatusSegments'
import { Section } from './overview/Section'
import { StatTiles, StatTilesSkeleton } from './overview/StatTiles'
import { ActivitySparkline } from './overview/ActivitySparkline'
import { MemberProgress } from './overview/MemberProgress'
import { ClassHistogram } from './overview/ClassHistogram'
import { MembersPresence } from './overview/MembersPresence'
import { OpenThreads } from './overview/OpenThreads'
import { IndexingBanner } from './overview/IndexingBanner'
import { useProjectStats } from './overview/chartUtils'

function hasOpenChat(state: unknown): boolean {
  return !!state && typeof state === 'object' && (state as { openChat?: unknown }).openChat === true
}

/** Project overview dashboard. */
export function ProjectPage() {
  const { projectId, project } = useProjectContext()
  const stats = useProjectStats(projectId)
  const location = useLocation()
  const navigate = useNavigate()
  const setChatOpen = useUi((s) => s.setChatOpen)
  const indexing = useRealtime((s) => s.indexing[projectId])
  const isIndexing = indexing ? !indexing.finished : project.indexing
  const perms = project.permissions
  const counts = stats.data?.status_counts ?? project.status_counts
  const reviewCount = counts.review ?? 0

  // Deep link from a project card's chat button.
  const openChat = hasOpenChat(location.state)
  useEffect(() => {
    if (!openChat) return
    setChatOpen(true)
    navigate('.', { replace: true, state: null })
  }, [openChat, setChatOpen, navigate])

  const rescan = useMutation({
    mutationFn: () => rescanProject(projectId),
    onSuccess: () => toast.success('Rescan started', { description: 'New and removed images are picked up in the background.' }),
    onError: (err) => toast.error('Could not start the rescan', { description: errorMessage(err) }),
  })

  const statsError = stats.isError ? (
    <ErrorState compact title="Could not load statistics" error={stats.error} onRetry={() => void stats.refetch()} />
  ) : null

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-5 px-6 py-6">
      <header className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold tracking-tight text-fg">{project.name}</h1>
            <FormatBadge format={project.label_format} />
            {project.archived && <Badge variant="outline" title="Archived projects are read-only">Archived · read-only</Badge>}
            <Badge variant="neutral">{project.my_role ? ROLE_LABELS[project.my_role] : 'Administrator'}</Badge>
          </div>
          {project.description && <p className="mt-1 max-w-3xl text-base text-muted">{project.description}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {perms.can_manage && (
            <Button variant="ghost" onClick={() => rescan.mutate()} loading={rescan.isPending} disabled={isIndexing}>
              <RefreshCw />
              Rescan
            </Button>
          )}
          {perms.can_manage && (
            <Button asChild variant="secondary">
              <Link to={`/p/${projectId}/settings`}>
                <Settings2 />
                Settings
              </Link>
            </Button>
          )}
          <Button asChild variant="secondary">
            <Link to={`/p/${projectId}/images`}>
              <Images />
              Images
            </Link>
          </Button>
          {perms.can_review && (
            <Button asChild variant="secondary">
              <Link to={`/p/${projectId}/annotate?status=review`}>
                <Search />
                Review queue
                {reviewCount > 0 && <Badge variant="warn">{formatNumber(reviewCount)}</Badge>}
              </Link>
            </Button>
          )}
          <Button asChild variant="primary">
            <Link to={`/p/${projectId}/annotate`}>
              <PenTool />
              {perms.can_edit ? 'Continue annotating' : 'Open viewer'}
            </Link>
          </Button>
        </div>
      </header>

      <IndexingBanner project={project} />

      {stats.isPending ? <StatTilesSkeleton /> : <StatTiles project={project} stats={stats.data} />}

      <div className="grid items-start gap-5 xl:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-5 xl:col-span-2">
          <Section name="Progress" title="Progress" description={`${formatNumber(project.image_count)} images`}>
            <div className="flex flex-col gap-3">
              <StatusBar counts={counts} total={stats.data?.images_total ?? project.image_count} />
              <StatusLegend counts={counts} />
            </div>
          </Section>

          <Section name="Activity chart" title="Last 30 days" description="Annotation saves and images finished per day">
            {stats.isPending ? <Skeleton className="h-[180px] w-full" /> : statsError ?? (stats.data && <ActivitySparkline daily={stats.data.daily} />)}
          </Section>

          <Section name="Team progress" title="Team progress">
            {stats.isPending ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-9 w-full" />
                ))}
              </div>
            ) : (
              statsError ?? (stats.data && <MemberProgress members={project.members} stats={stats.data} />)
            )}
          </Section>

          <Section name="Classes" title="Classes" description="Boxes per class">
            {stats.isPending ? (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="h-6 w-full" />
                ))}
              </div>
            ) : (
              statsError ?? (stats.data && <ClassHistogram classes={project.classes} stats={stats.data} />)
            )}
          </Section>
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          <Section name="Members" title="Members" description={`${formatNumber(project.member_count)} in this project`}>
            <MembersPresence projectId={projectId} members={project.members} />
          </Section>
          <Section name="Open threads" title="Open threads" description="Unresolved comments on images">
            <OpenThreads projectId={projectId} members={project.members} />
          </Section>
          <Section name="Activity" title="Activity" bodyClassName="max-h-[560px] overflow-y-auto">
            <ActivityFeed projectId={projectId} />
          </Section>
        </div>
      </div>
    </div>
  )
}
