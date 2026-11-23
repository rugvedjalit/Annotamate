// Connects the WebSocket for the signed-in user and applies every server event to the realtime store and
// the TanStack Query caches (setQueryData where possible, throttled invalidation otherwise).
import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { toast } from 'sonner'
import { qk } from '@/lib/queryKeys'
import { getAuthState } from '@/lib/endpoints'
import {
  appendChatMessage,
  isUnreadDmNotification,
  markConversationRead,
  markDirectMessagesRead,
  setNotificationsReadWhere,
  appendDirectMessage,
  patchProject,
  prependNotification,
  replaceChatMessage,
  setProjectClasses,
  upsertComment,
  upsertConversation,
  upsertImageItem,
} from '@/lib/cacheUpdates'
import type { Conversation, Notification, UserListItem } from '@/lib/types'
import { playChime } from '@/lib/sound'
import { realtime, useRealtime } from '@/stores/realtime'
import { useSession } from '@/stores/session'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { notificationHref, notificationState } from '@/features/notifications/notificationUtils'

/** Collects query keys and invalidates them once per window (bursty events → one refetch). */
function createThrottledInvalidator(qc: QueryClient, delayMs: number) {
  const pending = new Map<string, QueryKey>()
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    add(...keys: QueryKey[]) {
      for (const k of keys) pending.set(JSON.stringify(k), k)
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        const keysNow = [...pending.values()]
        pending.clear()
        for (const k of keysNow) void qc.invalidateQueries({ queryKey: k })
      }, delayMs)
    },
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      pending.clear()
    },
  }
}

const QUIET_ERROR_CODES = new Set(['locked', 'lock_denied', 'not_subscribed', 'not_found', 'unauthenticated'])
const TOAST_TYPES = new Set<Notification['type']>([
  'mention',
  'assignment',
  'review_approved',
  'review_rejected',
  'review_requested',
  'comment',
  'project_added',
])

function findUserBrief(qc: QueryClient, userId: number) {
  const conv = qc.getQueryData<Conversation[]>(qk.conversations)?.find((c) => c.user.id === userId)
  if (conv) return conv.user
  for (const [, users] of qc.getQueriesData<UserListItem[]>({ queryKey: qk.usersAll })) {
    const u = users?.find((x) => x.id === userId)
    if (u) return u
  }
  return null
}

export function RealtimeBridge() {
  const qc = useQueryClient()
  const navigateNow = useNavigate()
  const navRef = useRef(navigateNow)
  useEffect(() => {
    navRef.current = navigateNow
  }, [navigateNow])

  useEffect(() => {
    const navigate = (to: string, state?: unknown) => void navRef.current(to, state === undefined ? undefined : { state })
    const store = useRealtime.getState()
    const throttled = createThrottledInvalidator(qc, 1500)
    const me = () => useSession.getState().user?.id ?? -1
    const offs: (() => void)[] = []

    offs.push(realtime.onState((s) => store.setConnection(s)))
    offs.push(
      realtime.onOpen(({ reconnected }) => {
        // Missed events while disconnected: refetch what is on screen, mark the rest stale.
        if (reconnected) void qc.invalidateQueries()
      }),
    )
    offs.push(
      realtime.onClose(({ code }) => {
        if (code === 4401 || code === 4403 || code === 1008) {
          getAuthState()
            .then((s) => {
              if (!s.user) qc.setQueryData(qk.authState, s)
            })
            .catch(() => undefined)
        }
      }),
    )

    offs.push(realtime.on('hello', (m) => store.setOnline(m.online_user_ids)))
    offs.push(realtime.on('user.online', (m) => store.setUserOnline(m.user_id, true)))
    offs.push(realtime.on('user.offline', (m) => store.setUserOnline(m.user_id, false)))
    offs.push(realtime.on('presence.snapshot', (m) => store.setPresenceSnapshot(m.project_id, m.users)))
    offs.push(realtime.on('presence.update', (m) => store.updatePresence(m.project_id, m.user, m.image_id, m.image_filename ?? null, !!m.left)))
    offs.push(realtime.on('lock.state', (m) => store.setLock(m.image_id, m.holder)))

    offs.push(
      realtime.on('image.updated', (m) => {
        const pid = m.project_id
        upsertImageItem(qc, pid, m.image)
        if (m.version && m.by?.id !== me()) {
          void qc.invalidateQueries({ queryKey: qk.annotation(pid, m.image.id), refetchType: 'none' })
          void qc.invalidateQueries({ queryKey: qk.revisions(pid, m.image.id) })
        }
        throttled.add(qk.stats(pid), qk.project(pid), qk.projectsAll, qk.activityAll(pid), qk.members(pid))
      }),
    )
    offs.push(
      realtime.on('images.bulk_updated', (m) => {
        const pid = m.project_id
        throttled.add(qk.imagesAll(pid), qk.neighborsAll(pid), qk.stats(pid), qk.project(pid), qk.projectsAll, qk.activityAll(pid), qk.members(pid))
        // Image details may have changed assignee/status too.
        throttled.add(['project', pid, 'image'])
      }),
    )
    offs.push(
      realtime.on('classes.updated', (m) => {
        setProjectClasses(qc, m.project_id, m.classes)
        throttled.add(qk.stats(m.project_id), qk.activityAll(m.project_id))
      }),
    )
    offs.push(
      realtime.on('project.updated', (m) => {
        throttled.add(qk.project(m.project_id), qk.projectsAll)
      }),
    )
    offs.push(
      realtime.on('project.indexing', (m) => {
        store.setIndexing(m.project_id, { done: m.done, total: m.total, finished: m.finished })
        if (m.finished) {
          const pid = m.project_id
          for (const k of [qk.imagesAll(pid), qk.stats(pid), qk.project(pid), qk.projectsAll, qk.neighborsAll(pid)]) {
            void qc.invalidateQueries({ queryKey: k })
          }
          setTimeout(() => useRealtime.getState().setIndexing(pid, null), 4000)
        }
      }),
    )
    offs.push(
      realtime.on('members.updated', (m) => {
        throttled.add(qk.members(m.project_id), qk.project(m.project_id), qk.projectsAll)
      }),
    )

    offs.push(
      realtime.on('chat.message', (m) => {
        const msg = m.message
        appendChatMessage(qc, msg.project_id, msg)
        const ui = useUi.getState()
        const viewing = ui.chatOpen && ui.currentProjectId === msg.project_id
        if (msg.user.id !== me() && !viewing) {
          patchProject(qc, msg.project_id, (p) => ({ unread_chat: p.unread_chat + 1 }))
        }
      }),
    )
    offs.push(realtime.on('chat.updated', (m) => replaceChatMessage(qc, m.message.project_id, m.message)))

    offs.push(
      realtime.on('comment.created', (m) => {
        upsertComment(qc, m.comment)
        throttled.add(qk.threads(m.comment.project_id), qk.activityAll(m.comment.project_id))
      }),
    )
    offs.push(
      realtime.on('comment.updated', (m) => {
        upsertComment(qc, m.comment)
        throttled.add(qk.threads(m.comment.project_id))
      }),
    )

    offs.push(
      realtime.on('dm.message', (m) => {
        const msg = m.message
        const mine = msg.sender_id === me()
        const other = mine ? msg.recipient_id : msg.sender_id
        appendDirectMessage(qc, other, msg)
        const viewing = useUi.getState().activeDmUserId === other
        const brief = findUserBrief(qc, other)
        if (!upsertConversation(qc, other, brief, msg, !mine && !viewing)) {
          void qc.invalidateQueries({ queryKey: qk.conversations })
        }
        if (!mine && !viewing) {
          if (useSettings.getState().settings.notify_sound) playChime()
          toast(brief ? `${brief.display_name}` : 'New direct message', {
            description: msg.body.length > 120 ? `${msg.body.slice(0, 120)}…` : msg.body,
            action: { label: 'Reply', onClick: () => navigate(`/messages/${other}`) },
          })
        }
      }),
    )

    offs.push(
      realtime.on('dm.read', (m) => {
        if (m.sender_id === me()) {
          // Read receipt for my messages in the conversation with the reader.
          markDirectMessagesRead(qc, m.reader_id, m.sender_id, m.read_at)
          return
        }
        if (m.reader_id !== me()) return
        // I read the conversation (maybe in another tab): clear its unread badge and its notifications.
        markConversationRead(qc, m.sender_id)
        markDirectMessagesRead(qc, m.sender_id, m.sender_id, m.read_at)
        if (m.unread_count !== undefined) {
          setNotificationsReadWhere(qc, (n) => isUnreadDmNotification(n, m.sender_id), m.unread_count)
        }
      }),
    )

    offs.push(
      realtime.on('notification', (m) => {
        const n = m.notification
        const hasCache = qc.getQueriesData({ queryKey: qk.notificationsAll }).some(([, d]) => d !== undefined)
        if (hasCache) prependNotification(qc, n, m.unread_count)
        else void qc.invalidateQueries({ queryKey: qk.notificationsAll })
        if (n.type === 'assignment' && n.project) throttled.add(qk.projectsAll, qk.project(n.project.id))
        if (n.type === 'project_added') throttled.add(qk.projectsAll)
        if (!TOAST_TYPES.has(n.type)) return
        const ui = useUi.getState()
        const href = notificationHref(n)
        const alreadyThere = !!n.image && ui.currentImage?.id === n.image.id
        if (alreadyThere) return
        if (useSettings.getState().settings.notify_sound) playChime()
        toast(n.actor?.display_name ?? 'Annotamate', {
          description: n.text,
          action: href ? { label: 'Open', onClick: () => navigate(href, notificationState(n)) } : undefined,
        })
      }),
    )

    offs.push(
      realtime.on('typing', (m) => {
        if (m.user.id === me()) return
        if (m.scope === 'chat') {
          if (m.project_id === realtime.currentProjectId) store.setChatTyping(m.user)
        } else {
          store.setDmTyping(m.user.id)
        }
      }),
    )

    offs.push(
      realtime.on('error', (m) => {
        // Expected refusals (lock taken, project gone, sign-in needed: handled elsewhere) stay out of the console.
        if (QUIET_ERROR_CODES.has(m.code)) {
          console.debug('[realtime]', m.code, m.detail)
          return
        }
        console.warn('[realtime]', m.code, m.detail)
        if (m.detail) toast.error(m.detail)
      }),
    )

    const prune = setInterval(() => useRealtime.getState().pruneTyping(), 1000)
    realtime.connect()

    return () => {
      clearInterval(prune)
      throttled.cancel()
      for (const off of offs) off()
      realtime.disconnect()
      useRealtime.getState().reset()
    }
  }, [qc])

  return null
}
