// Route components. Feature pages are code-split; auth pages load eagerly (first screen).
import { lazy } from 'react'
import { Link } from 'react-router'
import { Compass } from 'lucide-react'
import { EmptyState } from '@/components/ui/Feedback'
import { Button } from '@/components/ui/Button'

export const ProjectsPage = lazy(() => import('@/features/projects/ProjectsPage').then((m) => ({ default: m.ProjectsPage })))
export const ProjectPage = lazy(() => import('@/features/projects/ProjectPage').then((m) => ({ default: m.ProjectPage })))
export const ImagesTablePage = lazy(() =>
  import('@/features/projects/ImagesTable').then((m) => ({ default: m.ImagesTablePage })),
)
export const ProjectSettingsPage = lazy(() =>
  import('@/features/projects/ProjectSettingsPage').then((m) => ({ default: m.ProjectSettingsPage })),
)
export const AnnotatorPage = lazy(() => import('@/features/annotator/AnnotatorPage').then((m) => ({ default: m.AnnotatorPage })))
export const MessagesPage = lazy(() => import('@/features/messages/MessagesPage').then((m) => ({ default: m.MessagesPage })))
export const NotificationsPage = lazy(() =>
  import('@/features/notifications/NotificationsPage').then((m) => ({ default: m.NotificationsPage })),
)
export const UsersPage = lazy(() => import('@/features/admin/UsersPage').then((m) => ({ default: m.UsersPage })))
export const AccountPage = lazy(() => import('@/features/account/AccountPage').then((m) => ({ default: m.AccountPage })))

export function NotFoundPage() {
  return (
    <EmptyState
      className="h-full"
      icon={<Compass />}
      title="Page not found"
      description="The link may be broken or the page may have moved."
      action={
        <Button asChild variant="secondary">
          <Link to="/">Back to projects</Link>
        </Button>
      }
    />
  )
}
