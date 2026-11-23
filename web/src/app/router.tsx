import { createBrowserRouter } from 'react-router'
import { ROUTER_BASENAME } from '@/lib/config'
import { AppShell, AuthedLayout, ProjectLayout, ProjectShell } from './layouts'
import { RequireAdmin, RequireAuth } from './guards'
import { LoginPage } from '@/features/auth/LoginPage'
import { SetupPage } from '@/features/auth/SetupPage'
import {
  AccountPage,
  AnnotatorPage,
  ImagesTablePage,
  MessagesPage,
  NotFoundPage,
  NotificationsPage,
  ProjectPage,
  ProjectSettingsPage,
  ProjectsPage,
  UsersPage,
} from './pages'

export const router = createBrowserRouter(
  [
    { path: '/setup', element: <SetupPage /> },
    { path: '/login', element: <LoginPage /> },
    {
      element: (
        <RequireAuth>
          <AuthedLayout />
        </RequireAuth>
      ),
      children: [
        {
          element: <AppShell />,
          children: [
            { index: true, element: <ProjectsPage /> },
            { path: 'messages/:userId?', element: <MessagesPage /> },
            { path: 'notifications', element: <NotificationsPage /> },
            { path: 'account/:tab?', element: <AccountPage /> },
            {
              path: 'admin/users',
              element: (
                <RequireAdmin>
                  <UsersPage />
                </RequireAdmin>
              ),
            },
            { path: '*', element: <NotFoundPage /> },
          ],
        },
        {
          path: 'p/:projectId',
          element: <ProjectLayout />,
          children: [
            {
              element: <ProjectShell />,
              children: [
                { index: true, element: <ProjectPage /> },
                { path: 'images', element: <ImagesTablePage /> },
                { path: 'settings/:tab?', element: <ProjectSettingsPage /> },
              ],
            },
            { path: 'annotate/:imageId?', element: <AnnotatorPage /> },
          ],
        },
      ],
    },
  ],
  { basename: ROUTER_BASENAME },
)
