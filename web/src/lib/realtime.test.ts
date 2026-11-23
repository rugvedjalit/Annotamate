import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RealtimeClient, type ConnectionState, type RealtimeOptions, type SocketLike } from './realtime'
import type { ClientMessage, ServerMessage } from './types'

class FakeWebSocket implements SocketLike {
  readyState = 0
  readonly sent: ClientMessage[] = []
  readonly closeCalls: { code?: number; reason?: string }[] = []
  onopen: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  readonly url: string

  constructor(url: string) {
    this.url = url
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('not open')
    this.sent.push(JSON.parse(data) as ClientMessage)
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason })
    this.readyState = 3
  }

  // ---- test controls
  serverOpen(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  serverSend(msg: ServerMessage | Record<string, unknown>): void {
    this.serverRaw(JSON.stringify(msg))
  }

  serverRaw(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }

  serverClose(code = 1006, reason = ''): void {
    this.readyState = 3
    this.onerror?.(new Event('error'))
    this.onclose?.({ code, reason } as CloseEvent)
  }
}

function setup(extra: Partial<RealtimeOptions> = {}) {
  const sockets: FakeWebSocket[] = []
  const client = new RealtimeClient({
    url: () => 'ws://test/api/ws',
    createSocket: (url) => {
      const ws = new FakeWebSocket(url)
      sockets.push(ws)
      return ws
    },
    watchBrowser: false,
    random: () => 1,
    ...extra,
  })
  const states: ConnectionState[] = []
  client.onState((s) => states.push(s))
  const last = () => {
    const ws = sockets[sockets.length - 1]
    if (!ws) throw new Error('no socket created')
    return ws
  }
  return { client, sockets, states, last }
}

describe('RealtimeClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('goes idle → connecting → open', () => {
    const { client, states, last, sockets } = setup()
    expect(client.state).toBe('idle')
    client.connect()
    expect(client.state).toBe('connecting')
    expect(sockets).toHaveLength(1)
    expect(last().url).toBe('ws://test/api/ws')
    last().serverOpen()
    expect(client.state).toBe('open')
    expect(client.isOpen()).toBe(true)
    expect(states).toEqual(['connecting', 'open'])
  })

  it('connect() is idempotent', () => {
    const { client, sockets } = setup()
    client.connect()
    client.connect()
    expect(sockets).toHaveLength(1)
  })

  it('replays the project subscription, presence and wanted locks on open', () => {
    const { client, last } = setup()
    client.subscribeProject(5)
    client.setPresence(9)
    client.acquireLock(42)
    client.acquireLock(43)
    expect(client.currentProjectId).toBe(5)
    client.connect()
    last().serverOpen()
    expect(last().sent).toEqual([
      { type: 'subscribe', project_id: 5 },
      { type: 'presence', image_id: 9 },
      { type: 'lock.acquire', image_id: 42 },
      { type: 'lock.acquire', image_id: 43 },
    ])
  })

  it('re-syncs everything after a reconnect and reports reconnected', () => {
    const { client, last, sockets } = setup()
    const opens: boolean[] = []
    client.onOpen(({ reconnected }) => opens.push(reconnected))
    client.connect()
    last().serverOpen()
    client.subscribeProject(5)
    client.setPresence(7)
    client.acquireLock(42, true)
    expect(last().sent).toEqual([
      { type: 'subscribe', project_id: 5 },
      { type: 'presence', image_id: 7 },
      { type: 'lock.acquire', image_id: 42, force: true },
    ])

    last().serverClose()
    expect(client.state).toBe('reconnecting')
    vi.advanceTimersByTime(500)
    expect(sockets).toHaveLength(2)
    last().serverOpen()
    // Re-acquire is never forced (a take-over must be explicit).
    expect(last().sent).toEqual([
      { type: 'subscribe', project_id: 5 },
      { type: 'presence', image_id: 7 },
      { type: 'lock.acquire', image_id: 42 },
    ])
    expect(opens).toEqual([false, true])
  })

  it('pings every 20 s while open', () => {
    const { client, last } = setup()
    client.connect()
    const ws = last()
    ws.serverOpen()
    vi.advanceTimersByTime(19_999)
    expect(ws.sent).toEqual([])
    vi.advanceTimersByTime(1)
    expect(ws.sent).toEqual([{ type: 'ping' }])
    ws.serverSend({ type: 'pong' })
    vi.advanceTimersByTime(20_000)
    expect(ws.sent).toEqual([{ type: 'ping' }, { type: 'ping' }])
  })

  it('keeps a socket that keeps answering', () => {
    const { client, last, sockets } = setup()
    client.connect()
    const ws = last()
    ws.serverOpen()
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(20_000)
      ws.serverSend({ type: 'pong' })
    }
    expect(sockets).toHaveLength(1)
    expect(client.state).toBe('open')
  })

  it('replaces a silent (half-open) socket after staleAfterMs', () => {
    const { client, last, sockets } = setup()
    const closes: number[] = []
    client.onClose(({ code }) => closes.push(code))
    client.connect()
    const ws = last()
    ws.serverOpen()
    vi.advanceTimersByTime(40_000)
    expect(client.state).toBe('open')
    vi.advanceTimersByTime(20_000) // 60 s without any frame > 50 s
    expect(ws.closeCalls).toEqual([{ code: 4000, reason: 'stale' }])
    expect(closes).toEqual([4000])
    expect(client.state).toBe('reconnecting')
    // Late events from the dead socket are ignored.
    ws.serverClose()
    expect(closes).toEqual([4000])
    vi.advanceTimersByTime(500)
    expect(sockets).toHaveLength(2)
  })

  it('backs off exponentially with jitter and a cap (random = 1 → upper bound)', () => {
    const { client, last, sockets } = setup({ backoffBaseMs: 500, backoffMaxMs: 15_000 })
    client.connect()
    last().serverOpen()
    last().serverClose()
    const expected = [500, 1000, 2000, 4000, 8000, 15_000, 15_000]
    for (const delay of expected) {
      const before = sockets.length
      vi.advanceTimersByTime(delay - 1)
      expect(sockets.length, `before ${delay}`).toBe(before)
      vi.advanceTimersByTime(1)
      expect(sockets.length, `after ${delay}`).toBe(before + 1)
      last().serverClose() // never opens
    }
  })

  it('uses half the delay when random = 0 (lower jitter bound)', () => {
    const { client } = setup({ random: () => 0, backoffBaseMs: 500, backoffMaxMs: 15_000 })
    expect([1, 2, 3, 4, 5, 6, 7].map(() => client.nextDelay())).toEqual([250, 500, 1000, 2000, 4000, 7500, 7500])
  })

  it('jitters within [50 %, 100 %] of the exponential delay', () => {
    const { client } = setup({ random: () => 0.5, backoffBaseMs: 1000, backoffMaxMs: 60_000 })
    expect(client.nextDelay()).toBe(750)
    expect(client.nextDelay()).toBe(1500)
  })

  it('resets the backoff when the server says hello', () => {
    const { client, last, sockets } = setup()
    client.connect()
    last().serverOpen()
    last().serverClose()
    vi.advanceTimersByTime(500)
    last().serverClose()
    vi.advanceTimersByTime(1000)
    // Opened without hello: the attempt counter keeps growing.
    last().serverOpen()
    last().serverClose()
    vi.advanceTimersByTime(1999)
    expect(sockets).toHaveLength(3)
    vi.advanceTimersByTime(1)
    expect(sockets).toHaveLength(4)
    last().serverOpen()
    last().serverSend({ type: 'hello', user_id: 1, online_user_ids: [1, 2] })
    last().serverClose()
    vi.advanceTimersByTime(500)
    expect(sockets).toHaveLength(5)
  })

  it('stays "connecting" when the first connection fails', () => {
    const { client, last, states } = setup()
    client.connect()
    last().serverClose()
    expect(client.state).toBe('connecting')
    expect(states).toEqual(['connecting'])
  })

  it('retries when the socket constructor throws', () => {
    let fail = true
    const sockets: FakeWebSocket[] = []
    const client = new RealtimeClient({
      url: () => 'ws://x',
      watchBrowser: false,
      random: () => 1,
      createSocket: (url) => {
        if (fail) throw new Error('blocked')
        const ws = new FakeWebSocket(url)
        sockets.push(ws)
        return ws
      },
    })
    client.connect()
    expect(client.state).toBe('connecting')
    fail = false
    vi.advanceTimersByTime(500)
    expect(sockets).toHaveLength(1)
  })

  it('delivers typed messages and ignores invalid frames', () => {
    const { client, last } = setup()
    const granted = vi.fn()
    const any = vi.fn()
    const off = client.on('lock.granted', granted)
    client.onAny(any)
    client.connect()
    const ws = last()
    ws.serverOpen()
    ws.serverSend({ type: 'lock.granted', image_id: 3 })
    expect(granted).toHaveBeenCalledWith({ type: 'lock.granted', image_id: 3 })
    ws.serverRaw('not json')
    ws.serverRaw(new ArrayBuffer(4))
    ws.serverSend({ no_type: true })
    ws.serverRaw('"just a string"')
    ws.serverRaw('null')
    ws.serverSend({ type: 'something.new', x: 1 })
    expect(granted).toHaveBeenCalledTimes(1)
    expect(any).toHaveBeenCalledTimes(2)
    expect(any).toHaveBeenLastCalledWith({ type: 'something.new', x: 1 })
    off()
    ws.serverSend({ type: 'lock.granted', image_id: 4 })
    expect(granted).toHaveBeenCalledTimes(1)
  })

  it('lets a listener unsubscribe itself while dispatching', () => {
    const { client, last } = setup()
    const second = vi.fn()
    const offFirst = client.on('pong', () => offFirst())
    client.on('pong', second)
    client.connect()
    last().serverOpen()
    last().serverSend({ type: 'pong' })
    last().serverSend({ type: 'pong' })
    expect(second).toHaveBeenCalledTimes(2)
  })

  it('releaseLock sends lock.release and stops re-acquiring after reconnects', () => {
    const { client, last } = setup()
    client.connect()
    last().serverOpen()
    client.acquireLock(42)
    expect(client.wantsLock(42)).toBe(true)
    client.releaseLock(42)
    client.releaseLock(99) // never wanted: nothing sent
    expect(client.wantsLock(42)).toBe(false)
    expect(last().sent).toEqual([
      { type: 'lock.acquire', image_id: 42 },
      { type: 'lock.release', image_id: 42 },
    ])
    last().serverClose()
    vi.advanceTimersByTime(500)
    last().serverOpen()
    expect(last().sent).toEqual([])
  })

  it('send() returns false when not open', () => {
    const { client, last } = setup()
    expect(client.send({ type: 'ping' })).toBe(false)
    client.connect()
    expect(client.send({ type: 'ping' })).toBe(false)
    last().serverOpen()
    expect(client.send({ type: 'ping' })).toBe(true)
    last().serverClose()
    expect(client.send({ type: 'ping' })).toBe(false)
  })

  it('handles project changes and presence', () => {
    const { client, last } = setup()
    client.connect()
    last().serverOpen()
    client.setPresence(3) // no project: not sent
    client.subscribeProject(5)
    client.subscribeProject(5) // same project: nothing
    client.setPresence(3)
    client.setPresence(3) // unchanged: nothing
    client.subscribeProject(6)
    client.subscribeProject(null)
    expect(last().sent).toEqual([
      { type: 'subscribe', project_id: 5 },
      { type: 'presence', image_id: 3 },
      { type: 'subscribe', project_id: 6 },
      { type: 'unsubscribe' },
    ])
    expect(client.currentProjectId).toBeNull()
  })

  it('resets presence when the project changes', () => {
    const { client, last } = setup()
    client.connect()
    last().serverOpen()
    client.subscribeProject(5)
    client.setPresence(3)
    client.subscribeProject(6)
    last().serverClose()
    vi.advanceTimersByTime(500)
    last().serverOpen()
    expect(last().sent).toEqual([
      { type: 'subscribe', project_id: 6 },
      { type: 'presence', image_id: null },
    ])
  })

  it('sends typing indicators', () => {
    const { client, last } = setup()
    client.connect()
    last().serverOpen()
    client.sendTyping('chat')
    client.sendTyping('dm', 3)
    expect(last().sent).toEqual([
      { type: 'typing', scope: 'chat' },
      { type: 'typing', scope: 'dm', user_id: 3 },
    ])
  })

  it('disconnect() closes, stops reconnecting and clears desired state', () => {
    const { client, last, sockets, states } = setup()
    client.subscribeProject(5)
    client.acquireLock(1)
    client.connect()
    const ws = last()
    ws.serverOpen()
    client.disconnect()
    expect(ws.closeCalls).toEqual([{ code: 1000, reason: 'bye' }])
    expect(client.state).toBe('closed')
    expect(states[states.length - 1]).toBe('closed')
    expect(client.currentProjectId).toBeNull()
    expect(client.wantsLock(1)).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)

    // A fresh connect starts clean (no replayed subscription or locks).
    const opens: boolean[] = []
    client.onOpen(({ reconnected }) => opens.push(reconnected))
    client.connect()
    last().serverOpen()
    expect(last().sent).toEqual([])
    expect(opens).toEqual([false])
  })

  it('disconnect() during the handshake closes the socket once it opens (no browser warning)', () => {
    const { client, last, sockets } = setup()
    client.connect()
    const ws = last()
    client.disconnect()
    expect(ws.closeCalls).toEqual([])
    expect(client.state).toBe('closed')
    ws.serverOpen()
    expect(ws.closeCalls).toEqual([{ code: 1000, reason: 'bye' }])
    expect(client.state).toBe('closed') // the late open is not treated as a connection
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
  })

  it('disconnect() cancels a pending reconnect', () => {
    const { client, last, sockets } = setup()
    client.connect()
    last().serverOpen()
    last().serverClose()
    client.disconnect()
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(1)
    expect(client.state).toBe('closed')
  })

  it('reconnectNow() skips the backoff wait', () => {
    const { client, last, sockets } = setup()
    client.connect()
    last().serverOpen()
    last().serverClose()
    expect(sockets).toHaveLength(1)
    client.reconnectNow()
    expect(sockets).toHaveLength(2)
    vi.advanceTimersByTime(60_000)
    expect(sockets).toHaveLength(2)
    client.reconnectNow() // a socket already exists: no-op
    expect(sockets).toHaveLength(2)
  })

  it('stops pinging after the socket closes', () => {
    const { client, last } = setup()
    client.connect()
    const ws = last()
    ws.serverOpen()
    ws.serverClose()
    vi.advanceTimersByTime(20_000)
    expect(ws.sent).toEqual([])
  })
})
