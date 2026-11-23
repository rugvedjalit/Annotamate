// WebSocket client: auto-reconnect with jittered exponential backoff, ping every 20 s, typed events,
// and re-sync of the subscribed project, presence and held locks after every reconnect.
import type { ClientMessage, ServerMessage, ServerMessageMap, ServerMessageType } from './types'

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

/** The subset of the browser WebSocket used by the client (lets tests inject a fake). */
export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: Event) => void) | null
  onclose: ((ev: CloseEvent) => void) | null
  onmessage: ((ev: MessageEvent) => void) | null
  onerror: ((ev: Event) => void) | null
}

export interface RealtimeOptions {
  url: () => string
  createSocket?: (url: string) => SocketLike
  pingIntervalMs?: number
  /** Without any frame for this long, the socket is considered dead and replaced. */
  staleAfterMs?: number
  backoffBaseMs?: number
  backoffMaxMs?: number
  random?: () => number
  /** Listen to window online/visibility events to reconnect early. */
  watchBrowser?: boolean
}

const CONNECTING = 0
const OPEN = 1

type AnyListener = (msg: ServerMessage) => void

export class RealtimeClient {
  private readonly opts: Required<Omit<RealtimeOptions, 'createSocket'>> & {
    createSocket: (url: string) => SocketLike
  }
  private socket: SocketLike | null = null
  private _state: ConnectionState = 'idle'
  private attempt = 0
  private stopped = true
  private hasConnected = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private lastFrameAt = 0

  private readonly listeners = new Map<string, Set<AnyListener>>()
  private readonly anyListeners = new Set<AnyListener>()
  private readonly stateListeners = new Set<(s: ConnectionState) => void>()
  private readonly openListeners = new Set<(info: { reconnected: boolean }) => void>()
  private readonly closeListeners = new Set<(info: { code: number; reason: string }) => void>()

  // Desired state, replayed after reconnects.
  private projectId: number | null = null
  private presenceImageId: number | null = null
  private readonly wantedLocks = new Set<number>()

  constructor(options: RealtimeOptions) {
    this.opts = {
      pingIntervalMs: 20_000,
      staleAfterMs: 50_000,
      backoffBaseMs: 500,
      backoffMaxMs: 15_000,
      random: Math.random,
      watchBrowser: true,
      ...options,
      createSocket: options.createSocket ?? ((url) => new WebSocket(url)),
    }
  }

  get state(): ConnectionState {
    return this._state
  }

  get currentProjectId(): number | null {
    return this.projectId
  }

  isOpen(): boolean {
    return this._state === 'open'
  }

  // ---------------------------------------------------------------- lifecycle

  connect(): void {
    if (!this.stopped) return
    this.stopped = false
    if (this.opts.watchBrowser && typeof window !== 'undefined') {
      window.addEventListener('online', this.handleBrowserWake)
      document.addEventListener('visibilitychange', this.handleBrowserWake)
    }
    this.open()
  }

  /** Close for good (sign-out). Desired state is cleared. */
  disconnect(): void {
    this.stopped = true
    this.clearTimers()
    if (this.opts.watchBrowser && typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleBrowserWake)
      document.removeEventListener('visibilitychange', this.handleBrowserWake)
    }
    const ws = this.socket
    this.socket = null
    if (ws) {
      ws.onmessage = ws.onerror = null
      ws.onclose = null
      const close = () => {
        try {
          ws.close(1000, 'bye')
        } catch {
          // already closed
        }
      }
      if (ws.readyState === CONNECTING) {
        // Closing a socket during its handshake makes browsers log a warning: close it once it opens.
        ws.onopen = close
      } else {
        ws.onopen = null
        close()
      }
    }
    this.projectId = null
    this.presenceImageId = null
    this.wantedLocks.clear()
    this.hasConnected = false
    this.attempt = 0
    this.setState('closed')
  }

  /** Skip the backoff wait and try again now (e.g. the browser came back online). */
  reconnectNow(): void {
    if (this.stopped || this.socket) return
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.open()
  }

  private handleBrowserWake = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (this._state === 'reconnecting' && !this.socket) this.reconnectNow()
  }

  private open(): void {
    this.setState(this.hasConnected ? 'reconnecting' : 'connecting')
    let ws: SocketLike
    try {
      ws = this.opts.createSocket(this.opts.url())
    } catch {
      this.scheduleReconnect()
      return
    }
    this.socket = ws
    ws.onopen = () => {
      if (this.socket !== ws) return
      const reconnected = this.hasConnected
      this.hasConnected = true
      this.lastFrameAt = Date.now()
      this.setState('open')
      this.startPing()
      this.resync()
      for (const l of this.openListeners) l({ reconnected })
    }
    ws.onmessage = (ev) => {
      if (this.socket !== ws) return
      this.lastFrameAt = Date.now()
      this.dispatch(ev.data)
    }
    ws.onerror = () => {
      // A close event always follows; reconnection is handled there.
    }
    ws.onclose = (ev) => {
      if (this.socket !== ws) return
      this.handleClosed(ev.code, ev.reason)
    }
  }

  private handleClosed(code: number, reason: string): void {
    this.socket = null
    this.stopPing()
    for (const l of this.closeListeners) l({ code, reason })
    if (this.stopped) {
      this.setState('closed')
      return
    }
    this.setState(this.hasConnected ? 'reconnecting' : 'connecting')
    this.scheduleReconnect()
  }

  /** Next reconnect delay: exponential, capped, with 50–100 % jitter. */
  nextDelay(): number {
    const raw = Math.min(this.opts.backoffMaxMs, this.opts.backoffBaseMs * 2 ** this.attempt)
    this.attempt = Math.min(this.attempt + 1, 30)
    return Math.round(raw * (0.5 + this.opts.random() * 0.5))
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = this.nextDelay()
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped && !this.socket) this.open()
    }, delay)
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      const ws = this.socket
      if (!ws) return
      if (Date.now() - this.lastFrameAt > this.opts.staleAfterMs) {
        // Half-open connection: drop it and reconnect.
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        try {
          ws.close(4000, 'stale')
        } catch {
          // ignore
        }
        this.handleClosed(4000, 'stale')
        return
      }
      this.send({ type: 'ping' })
    }, this.opts.pingIntervalMs)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private clearTimers(): void {
    this.stopPing()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private setState(s: ConnectionState): void {
    if (this._state === s) return
    this._state = s
    for (const l of this.stateListeners) l(s)
  }

  private resync(): void {
    if (this.projectId !== null) {
      this.send({ type: 'subscribe', project_id: this.projectId })
      this.send({ type: 'presence', image_id: this.presenceImageId })
    }
    for (const imageId of this.wantedLocks) this.send({ type: 'lock.acquire', image_id: imageId })
  }

  private dispatch(data: unknown): void {
    if (typeof data !== 'string') return
    let msg: unknown
    try {
      msg = JSON.parse(data)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return
    const typed = msg as ServerMessage
    if (typed.type === 'hello') this.attempt = 0
    const set = this.listeners.get(typed.type)
    if (set) for (const l of [...set]) l(typed)
    for (const l of [...this.anyListeners]) l(typed)
  }

  // ---------------------------------------------------------------- outgoing

  /** Send if connected; returns false when the frame was dropped. */
  send(msg: ClientMessage): boolean {
    const ws = this.socket
    if (!ws || ws.readyState !== OPEN || this._state !== 'open') return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  /** Join a project room (null leaves). Presence resets on project change. */
  subscribeProject(projectId: number | null): void {
    if (this.projectId === projectId) return
    this.projectId = projectId
    this.presenceImageId = null
    if (projectId === null) this.send({ type: 'unsubscribe' })
    else this.send({ type: 'subscribe', project_id: projectId })
  }

  setPresence(imageId: number | null): void {
    if (this.presenceImageId === imageId) return
    this.presenceImageId = imageId
    if (this.projectId !== null) this.send({ type: 'presence', image_id: imageId })
  }

  /** Request the edit lock; it is re-requested automatically after reconnects until released. */
  acquireLock(imageId: number, force = false): void {
    this.wantedLocks.add(imageId)
    this.send(force ? { type: 'lock.acquire', image_id: imageId, force: true } : { type: 'lock.acquire', image_id: imageId })
  }

  releaseLock(imageId: number): void {
    const had = this.wantedLocks.delete(imageId)
    if (had) this.send({ type: 'lock.release', image_id: imageId })
  }

  /**
   * Stop re-requesting a lock after reconnects without releasing it (it was taken over: another tab or a
   * manager holds it now, and a replayed request must not take it back).
   */
  forgetLock(imageId: number): void {
    this.wantedLocks.delete(imageId)
  }

  wantsLock(imageId: number): boolean {
    return this.wantedLocks.has(imageId)
  }

  sendTyping(scope: 'chat'): void
  sendTyping(scope: 'dm', userId: number): void
  sendTyping(scope: 'chat' | 'dm', userId?: number): void {
    if (scope === 'dm' && userId !== undefined) this.send({ type: 'typing', scope: 'dm', user_id: userId })
    else if (scope === 'chat') this.send({ type: 'typing', scope: 'chat' })
  }

  // ---------------------------------------------------------------- subscriptions

  on<K extends ServerMessageType>(type: K, listener: (msg: ServerMessageMap[K]) => void): () => void {
    let set = this.listeners.get(type)
    if (!set) {
      set = new Set()
      this.listeners.set(type, set)
    }
    const l = listener as AnyListener
    set.add(l)
    return () => {
      set.delete(l)
    }
  }

  onAny(listener: (msg: ServerMessage) => void): () => void {
    this.anyListeners.add(listener)
    return () => {
      this.anyListeners.delete(listener)
    }
  }

  onState(listener: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  onOpen(listener: (info: { reconnected: boolean }) => void): () => void {
    this.openListeners.add(listener)
    return () => {
      this.openListeners.delete(listener)
    }
  }

  onClose(listener: (info: { code: number; reason: string }) => void): () => void {
    this.closeListeners.add(listener)
    return () => {
      this.closeListeners.delete(listener)
    }
  }
}
