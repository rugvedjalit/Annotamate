// TanStack Query keys. Everything project-scoped starts with ['project', pid] so a project can be
// invalidated as a whole.
import { toFilterQuery, type ImageFilters } from './filters'

export const IMAGE_PAGE_SIZE = 200

export const qk = {
  meta: ['meta'] as const,
  authState: ['auth', 'state'] as const,
  settings: ['me', 'settings'] as const,
  users: (includeInactive = false) => ['users', { includeInactive }] as const,
  adminUsers: (includeInactive = false) => ['users', 'admin', { includeInactive }] as const,
  usersAll: ['users'] as const,
  fsRoots: ['fs', 'roots'] as const,
  fsBrowse: (path: string) => ['fs', 'browse', path] as const,

  projects: (archived = false) => ['projects', { archived }] as const,
  projectsAll: ['projects'] as const,
  project: (pid: number) => ['project', pid] as const,
  stats: (pid: number) => ['project', pid, 'stats'] as const,
  members: (pid: number) => ['project', pid, 'members'] as const,

  /** Prefix of every image list page of a project (any filter). */
  imagesAll: (pid: number) => ['project', pid, 'images'] as const,
  /** Prefix of every page for one filter. */
  images: (pid: number, filters: ImageFilters) => ['project', pid, 'images', toFilterQuery(filters)] as const,
  imagesPage: (pid: number, filters: ImageFilters, page: number, pageSize = IMAGE_PAGE_SIZE) =>
    ['project', pid, 'images', toFilterQuery(filters), { page, pageSize }] as const,
  image: (pid: number, iid: number) => ['project', pid, 'image', iid] as const,
  neighborsAll: (pid: number) => ['project', pid, 'neighbors'] as const,
  neighbors: (pid: number, iid: number, filters: ImageFilters) =>
    ['project', pid, 'neighbors', iid, toFilterQuery(filters)] as const,
  annotation: (pid: number, iid: number) => ['project', pid, 'annotation', iid] as const,
  revisions: (pid: number, iid: number) => ['project', pid, 'revisions', iid] as const,
  revision: (pid: number, iid: number, rid: number) => ['project', pid, 'revisions', iid, rid] as const,
  comments: (pid: number, iid: number) => ['project', pid, 'comments', iid] as const,
  threads: (pid: number) => ['project', pid, 'threads'] as const,
  chat: (pid: number) => ['project', pid, 'chat'] as const,
  activityAll: (pid: number) => ['project', pid, 'activity'] as const,
  activity: (pid: number, filter: { user_id?: number; image_id?: number } = {}) =>
    ['project', pid, 'activity', filter] as const,

  conversations: ['dm', 'list'] as const,
  dm: (userId: number) => ['dm', 'thread', userId] as const,
  notifications: (unreadOnly = false) => ['notifications', { unreadOnly }] as const,
  notificationsAll: ['notifications'] as const,
}
