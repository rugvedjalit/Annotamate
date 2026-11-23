// Shared queries used across features.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { qk } from '@/lib/queryKeys'
import {
  getConversations,
  getMembers,
  getMeta,
  getNotifications,
  getProject,
  getProjects,
  getUsers,
} from '@/lib/endpoints'

export function useMeta() {
  return useQuery({ queryKey: qk.meta, queryFn: ({ signal }) => getMeta({ signal }), staleTime: Infinity })
}

export function useProjects(archived = false) {
  return useQuery({
    queryKey: qk.projects(archived),
    queryFn: ({ signal }) => getProjects(archived, { signal }),
    staleTime: 15_000,
  })
}

export function useProject(projectId: number) {
  return useQuery({
    queryKey: qk.project(projectId),
    queryFn: ({ signal }) => getProject(projectId, { signal }),
    staleTime: 30_000,
    enabled: Number.isFinite(projectId),
  })
}

export function useMembers(projectId: number) {
  return useQuery({
    queryKey: qk.members(projectId),
    queryFn: ({ signal }) => getMembers(projectId, { signal }),
    staleTime: 30_000,
  })
}

export function useUsers(includeInactive = false, enabled = true) {
  return useQuery({
    queryKey: qk.users(includeInactive),
    queryFn: ({ signal }) => getUsers(includeInactive, { signal }),
    staleTime: 30_000,
    enabled,
  })
}

export function useConversations() {
  return useQuery({
    queryKey: qk.conversations,
    queryFn: ({ signal }) => getConversations({ signal }),
    staleTime: 30_000,
  })
}

/** Unread direct messages across conversations. */
export function useDmUnread(): number {
  const { data } = useConversations()
  return data?.reduce((sum, c) => sum + c.unread_count, 0) ?? 0
}

export const NOTIFICATIONS_PAGE_SIZE = 30

/** Shared by the bell menu and the notifications page (same cache, updated by realtime events). */
export function useNotifications(unreadOnly = false) {
  return useInfiniteQuery({
    queryKey: qk.notifications(unreadOnly),
    queryFn: ({ pageParam, signal }) =>
      getNotifications({ before_id: pageParam, limit: NOTIFICATIONS_PAGE_SIZE, unread: unreadOnly }, { signal }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.has_more ? last.items[last.items.length - 1]?.id : undefined),
    staleTime: 30_000,
  })
}
