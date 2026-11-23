// Query-cache updates shared by realtime events and mutations (setQueryData instead of refetching).
import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { qk } from './queryKeys'
import type {
  ChatMessage,
  Comment,
  Conversation,
  CursorPage,
  DirectMessage,
  ImageDetail,
  ImageItem,
  ImagePage,
  Notification,
  NotificationsPage,
  Project,
  ProjectClass,
  ProjectSummary,
  UserBrief,
} from './types'

export type CursorInfinite<T> = InfiniteData<CursorPage<T>, number | undefined>

/** Replace an image row everywhere it is cached (all list pages and the detail). */
export function upsertImageItem(qc: QueryClient, projectId: number, item: ImageItem): void {
  qc.setQueriesData<ImagePage>({ queryKey: qk.imagesAll(projectId) }, (old) => {
    if (!old?.items) return old
    const i = old.items.findIndex((x) => x.id === item.id)
    if (i < 0) return old
    const items = old.items.slice()
    items[i] = item
    return { ...old, items }
  })
  qc.setQueryData<ImageDetail>(qk.image(projectId, item.id), (old) => (old ? { ...old, ...item } : old))
}

/** Find a cached image row (detail or any list page). */
export function findCachedImage(qc: QueryClient, projectId: number, imageId: number): ImageItem | undefined {
  const detail = qc.getQueryData<ImageDetail>(qk.image(projectId, imageId))
  if (detail) return detail
  for (const [, page] of qc.getQueriesData<ImagePage>({ queryKey: qk.imagesAll(projectId) })) {
    const hit = page?.items?.find((x) => x.id === imageId)
    if (hit) return hit
  }
  return undefined
}

export function patchProject(qc: QueryClient, projectId: number, fn: (p: ProjectSummary) => Partial<ProjectSummary>): void {
  qc.setQueryData<Project>(qk.project(projectId), (old) => (old ? { ...old, ...fn(old) } : old))
  qc.setQueriesData<ProjectSummary[]>({ queryKey: qk.projectsAll }, (old) =>
    old?.map((p) => (p.id === projectId ? { ...p, ...fn(p) } : p)),
  )
}

export function setProjectClasses(qc: QueryClient, projectId: number, classes: ProjectClass[]): void {
  const sorted = [...classes].sort((a, b) => a.index - b.index)
  qc.setQueryData<Project>(qk.project(projectId), (old) => (old ? { ...old, classes: sorted } : old))
}

// ---------- chat (pages[0] holds the newest messages, items ascending inside a page) ----------

export function appendChatMessage(qc: QueryClient, projectId: number, msg: ChatMessage): boolean {
  let added = false
  qc.setQueryData<CursorInfinite<ChatMessage>>(qk.chat(projectId), (old) => {
    if (!old || old.pages.length === 0) return old
    if (old.pages.some((p) => p.items.some((m) => m.id === msg.id))) return old
    added = true
    const [first, ...rest] = old.pages
    return { ...old, pages: [{ ...first!, items: [...first!.items, msg] }, ...rest] }
  })
  return added
}

export function replaceChatMessage(qc: QueryClient, projectId: number, msg: ChatMessage): void {
  qc.setQueryData<CursorInfinite<ChatMessage>>(qk.chat(projectId), (old) =>
    old
      ? {
          ...old,
          pages: old.pages.map((p) => ({ ...p, items: p.items.map((m) => (m.id === msg.id ? msg : m)) })),
        }
      : old,
  )
}

// ---------- comments ----------

export function upsertComment(qc: QueryClient, comment: Comment): void {
  qc.setQueryData<Comment[]>(qk.comments(comment.project_id, comment.image_id), (old) => {
    if (!old) return old
    const i = old.findIndex((c) => c.id === comment.id)
    if (i < 0) return [...old, comment]
    const next = old.slice()
    next[i] = comment
    return next
  })
}

// ---------- direct messages ----------

export function appendDirectMessage(qc: QueryClient, otherUserId: number, msg: DirectMessage): void {
  qc.setQueryData<CursorInfinite<DirectMessage>>(qk.dm(otherUserId), (old) => {
    if (!old || old.pages.length === 0) return old
    if (old.pages.some((p) => p.items.some((m) => m.id === msg.id))) return old
    const [first, ...rest] = old.pages
    return { ...old, pages: [{ ...first!, items: [...first!.items, msg] }, ...rest] }
  })
}

/**
 * Move/insert the conversation with `otherUserId` to the top with the new last message.
 * Returns false when the conversation is unknown and no user brief is available (caller refetches).
 */
export function upsertConversation(
  qc: QueryClient,
  otherUserId: number,
  otherUser: UserBrief | null,
  msg: DirectMessage,
  incrementUnread: boolean,
): boolean {
  let updatedOk = false
  qc.setQueryData<Conversation[]>(qk.conversations, (old) => {
    if (!old) return old
    const current = old.find((c) => c.user.id === otherUserId)
    const user = current?.user ?? otherUser
    if (!user) return old
    updatedOk = true
    const updated: Conversation = {
      user,
      last_message: msg,
      unread_count: (current?.unread_count ?? 0) + (incrementUnread ? 1 : 0),
    }
    return [updated, ...old.filter((c) => c.user.id !== otherUserId)]
  })
  return updatedOk
}

/** In the conversation with `otherUserId`, every unread message sent by `senderId` was read at `readAt`. */
export function markDirectMessagesRead(qc: QueryClient, otherUserId: number, senderId: number, readAt: string): void {
  qc.setQueryData<CursorInfinite<DirectMessage>>(qk.dm(otherUserId), (old) =>
    old
      ? {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            items: p.items.map((m) => (m.sender_id === senderId && !m.read_at ? { ...m, read_at: readAt } : m)),
          })),
        }
      : old,
  )
}

export function markConversationRead(qc: QueryClient, userId: number): void {
  qc.setQueryData<Conversation[]>(qk.conversations, (old) =>
    old?.map((c) => (c.user.id === userId ? { ...c, unread_count: 0 } : c)),
  )
}

// ---------- notifications ----------

/** Unread direct-message notification from `actorId` (the server keeps one per sender, replacing older ones). */
export function isUnreadDmNotification(n: Notification, actorId: number): boolean {
  return !n.read_at && !n.project && n.actor?.id === actorId && (n.type === 'dm' || n.type === 'mention')
}

export function prependNotification(qc: QueryClient, n: Notification, unreadCount: number): void {
  // A new DM summary replaces the sender's previous unread one (server-side it was deleted).
  const replaces = n.type === 'dm' || (n.type === 'mention' && !n.project) ? n.actor?.id ?? null : null
  qc.setQueriesData<InfiniteData<NotificationsPage, number | undefined>>({ queryKey: qk.notificationsAll }, (old) => {
    if (!old || old.pages.length === 0) return old
    if (old.pages.some((p) => p.items.some((x) => x.id === n.id))) return old
    const keep = (x: Notification) => replaces === null || !isUnreadDmNotification(x, replaces)
    const [first, ...rest] = old.pages
    return {
      ...old,
      pages: [
        { ...first!, items: [n, ...first!.items.filter(keep)], unread_count: unreadCount },
        ...rest.map((p) => ({ ...p, items: p.items.filter(keep), unread_count: unreadCount })),
      ],
    }
  })
}

/** Mark cached notifications matching `predicate` read and set the server's unread count. */
export function setNotificationsReadWhere(qc: QueryClient, predicate: (n: Notification) => boolean, unreadCount: number): void {
  const now = new Date().toISOString()
  qc.setQueriesData<InfiniteData<NotificationsPage, number | undefined>>({ queryKey: qk.notificationsAll }, (old) =>
    old
      ? {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            unread_count: unreadCount,
            items: p.items.map((n) => (!n.read_at && predicate(n) ? { ...n, read_at: now } : n)),
          })),
        }
      : old,
  )
}

export function setNotificationsRead(qc: QueryClient, ids: number[] | 'all', unreadCount: number): void {
  const now = new Date().toISOString()
  qc.setQueriesData<InfiniteData<NotificationsPage, number | undefined>>({ queryKey: qk.notificationsAll }, (old) =>
    old
      ? {
          ...old,
          pages: old.pages.map((p) => ({
            ...p,
            unread_count: unreadCount,
            items: p.items.map((n) => (!n.read_at && (ids === 'all' || ids.includes(n.id)) ? { ...n, read_at: now } : n)),
          })),
        }
      : old,
  )
}
