// Live state fed by the WebSocket: connection, online users, project presence, image locks,
// indexing progress and typing indicators.
import { create } from 'zustand'
import { RealtimeClient, type ConnectionState } from '@/lib/realtime'
import { wsUrl } from '@/lib/config'
import type { PresenceEntry, UserBrief } from '@/lib/types'

/** The app-wide WebSocket client (one connection per tab). */
export const realtime = new RealtimeClient({ url: wsUrl })

export interface PresenceInfo {
  user: UserBrief
  imageId: number | null
  imageFilename: string | null
}

export interface IndexingProgress {
  done: number
  total: number
  finished: boolean
}

interface RealtimeState {
  connection: ConnectionState
  everConnected: boolean
  onlineUserIds: ReadonlySet<number>
  /** Presence in the subscribed project, keyed by user id. */
  presenceProjectId: number | null
  presence: Record<number, PresenceInfo>
  /** imageId → lock holder, from lock.state broadcasts in the subscribed project. */
  locks: Record<number, UserBrief>
  indexing: Record<number, IndexingProgress>
  /** userId → {user, until} for the subscribed project's chat. */
  chatTyping: Record<number, { user: UserBrief; until: number }>
  /** userId → until, for DMs. */
  dmTyping: Record<number, number>

  setConnection: (s: ConnectionState) => void
  setOnline: (ids: number[]) => void
  setUserOnline: (id: number, online: boolean) => void
  setPresenceSnapshot: (projectId: number, users: PresenceEntry[]) => void
  updatePresence: (projectId: number, user: UserBrief, imageId: number | null, imageFilename: string | null, left: boolean) => void
  clearProject: () => void
  setLock: (imageId: number, holder: UserBrief | null) => void
  setIndexing: (projectId: number, p: IndexingProgress | null) => void
  setChatTyping: (user: UserBrief) => void
  setDmTyping: (userId: number) => void
  pruneTyping: () => void
  reset: () => void
}

const TYPING_TTL_MS = 5000

const initial = {
  connection: 'idle' as ConnectionState,
  everConnected: false,
  onlineUserIds: new Set<number>() as ReadonlySet<number>,
  presenceProjectId: null,
  presence: {},
  locks: {},
  indexing: {},
  chatTyping: {},
  dmTyping: {},
}

export const useRealtime = create<RealtimeState>()((set) => ({
  ...initial,
  setConnection: (connection) =>
    set((s) => ({ connection, everConnected: s.everConnected || connection === 'open' })),
  setOnline: (ids) => set({ onlineUserIds: new Set(ids) }),
  setUserOnline: (id, online) =>
    set((s) => {
      if (s.onlineUserIds.has(id) === online) return s
      const next = new Set(s.onlineUserIds)
      if (online) next.add(id)
      else next.delete(id)
      return { onlineUserIds: next }
    }),
  // A snapshot starts a fresh view of the room (after subscribing or reconnecting): the server follows it with
  // one lock.state frame per held lock, so locks seen before are dropped (they may have been released meanwhile).
  setPresenceSnapshot: (projectId, users) =>
    set(() => {
      const presence: Record<number, PresenceInfo> = {}
      for (const u of users) presence[u.user.id] = { user: u.user, imageId: u.image_id, imageFilename: u.image_filename ?? null }
      return { presenceProjectId: projectId, presence, locks: {} }
    }),
  updatePresence: (projectId, user, imageId, imageFilename, left) =>
    set((s) => {
      if (s.presenceProjectId !== null && s.presenceProjectId !== projectId) return s
      const presence = { ...s.presence }
      if (left) delete presence[user.id]
      else presence[user.id] = { user, imageId, imageFilename }
      return { presenceProjectId: projectId, presence }
    }),
  clearProject: () => set({ presenceProjectId: null, presence: {}, locks: {}, chatTyping: {} }),
  setLock: (imageId, holder) =>
    set((s) => {
      const locks = { ...s.locks }
      if (holder) locks[imageId] = holder
      else delete locks[imageId]
      return { locks }
    }),
  setIndexing: (projectId, p) =>
    set((s) => {
      const indexing = { ...s.indexing }
      if (p) indexing[projectId] = p
      else delete indexing[projectId]
      return { indexing }
    }),
  setChatTyping: (user) =>
    set((s) => ({ chatTyping: { ...s.chatTyping, [user.id]: { user, until: Date.now() + TYPING_TTL_MS } } })),
  setDmTyping: (userId) => set((s) => ({ dmTyping: { ...s.dmTyping, [userId]: Date.now() + TYPING_TTL_MS } })),
  pruneTyping: () =>
    set((s) => {
      const now = Date.now()
      const chat = Object.entries(s.chatTyping).filter(([, v]) => v.until > now)
      const dm = Object.entries(s.dmTyping).filter(([, until]) => until > now)
      if (chat.length === Object.keys(s.chatTyping).length && dm.length === Object.keys(s.dmTyping).length) return s
      return { chatTyping: Object.fromEntries(chat), dmTyping: Object.fromEntries(dm) }
    }),
  reset: () => set({ ...initial, onlineUserIds: new Set<number>() }),
}))

export function useIsOnline(userId: number | undefined | null): boolean {
  return useRealtime((s) => (userId != null ? s.onlineUserIds.has(userId) : false))
}
