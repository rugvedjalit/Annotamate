import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { ImageCache } from './imageCache'

interface FakeBitmap {
  url: string
  close: Mock<() => void>
}

type FetchFn = (input: string, init: RequestInit) => Promise<Response>

/** A fetch whose responses resolve only when the test says so (or reject when aborted). */
function controllableFetch() {
  const pending = new Map<string, { resolve: (r: Response) => void; reject: (e: unknown) => void; signal: AbortSignal }>()
  const fn: Mock<FetchFn> = vi.fn((input: string, init: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      const signal = init.signal as AbortSignal
      pending.set(input, { resolve, reject, signal })
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
  })
  return {
    fn,
    respond(url: string, status = 200) {
      const p = pending.get(url)
      if (!p) throw new Error(`no pending request for ${url}`)
      pending.delete(url)
      p.resolve(new Response(url, { status }))
    },
    signal(url: string) {
      return pending.get(url)?.signal
    },
  }
}

/** Let queued promise callbacks (fetch → blob → decode → cache) run. */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

describe('ImageCache', () => {
  let bitmaps: FakeBitmap[]
  let decodeFails: boolean

  beforeEach(() => {
    bitmaps = []
    decodeFails = false
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (blob: Blob) => {
        if (decodeFails) throw new Error('bad image')
        const bmp: FakeBitmap = { url: await blob.text(), close: vi.fn() }
        bitmaps.push(bmp)
        return bmp
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function okFetch(): Mock<FetchFn> {
    const fn: Mock<FetchFn> = vi.fn(async (input: string) => new Response(input, { status: 200 }))
    vi.stubGlobal('fetch', fn)
    return fn
  }

  it('fetches with cookies and decodes to a bitmap', async () => {
    const fetchFn = okFetch()
    const cache = new ImageCache(4)
    const img = await cache.load('/a.jpg')
    expect(img).toBe(bitmaps[0])
    expect(fetchFn).toHaveBeenCalledWith('/a.jpg', expect.objectContaining({ credentials: 'same-origin' }))
    expect(cache.get('/a.jpg')).toBe(img)
  })

  it('de-duplicates concurrent loads of the same URL', async () => {
    const fetchFn = okFetch()
    const cache = new ImageCache(4)
    const [a, b] = await Promise.all([cache.load('/a.jpg'), cache.load('/a.jpg')])
    expect(a).toBe(b)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    await cache.load('/a.jpg')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('get() is undefined until the image is decoded', async () => {
    const ctl = controllableFetch()
    vi.stubGlobal('fetch', ctl.fn)
    const cache = new ImageCache(4)
    const p = cache.load('/a.jpg')
    expect(cache.get('/a.jpg')).toBeUndefined()
    ctl.respond('/a.jpg')
    await p
    expect(cache.get('/a.jpg')).toBeDefined()
  })

  it('evicts the least recently used image and closes its bitmap', async () => {
    okFetch()
    const cache = new ImageCache(2)
    const a = await cache.load('/a.jpg')
    const b = await cache.load('/b.jpg')
    await cache.load('/c.jpg')
    expect(cache.size).toBe(2)
    expect(cache.get('/a.jpg')).toBeUndefined()
    expect((a as unknown as FakeBitmap).close).toHaveBeenCalledTimes(1)
    expect(cache.get('/b.jpg')).toBe(b)
    expect((b as unknown as FakeBitmap).close).not.toHaveBeenCalled()
  })

  it('refreshes recency on get()', async () => {
    okFetch()
    const cache = new ImageCache(2)
    const a = await cache.load('/a.jpg')
    const b = await cache.load('/b.jpg')
    cache.get('/a.jpg')
    await cache.load('/c.jpg')
    expect(cache.get('/a.jpg')).toBe(a)
    expect(cache.get('/b.jpg')).toBeUndefined()
    expect((b as unknown as FakeBitmap).close).toHaveBeenCalled()
  })

  it('never evicts pinned images', async () => {
    okFetch()
    const cache = new ImageCache(2)
    const a = await cache.load('/a.jpg')
    const unpin = cache.pin('/a.jpg')
    await cache.load('/b.jpg')
    await cache.load('/c.jpg')
    await cache.load('/d.jpg')
    expect(cache.get('/a.jpg')).toBe(a)
    expect((a as unknown as FakeBitmap).close).not.toHaveBeenCalled()
    unpin()
    await cache.load('/e.jpg')
    expect(cache.size).toBeLessThanOrEqual(2)
  })

  it('cancelPrefetchesExcept aborts unwanted in-flight prefetches only', async () => {
    const ctl = controllableFetch()
    vi.stubGlobal('fetch', ctl.fn)
    const cache = new ImageCache(8)
    cache.prefetch('/p1.jpg')
    cache.prefetch('/p2.jpg')
    const fg = cache.load('/fg.jpg')
    const s1 = ctl.signal('/p1.jpg')
    const s2 = ctl.signal('/p2.jpg')
    const sfg = ctl.signal('/fg.jpg')
    cache.cancelPrefetchesExcept(['/p2.jpg'])
    expect(s1?.aborted).toBe(true)
    expect(s2?.aborted).toBe(false)
    expect(sfg?.aborted).toBe(false)
    expect(cache.size).toBe(2)
    ctl.respond('/fg.jpg')
    await expect(fg).resolves.toBeDefined()
  })

  it('a foreground load of a prefetched URL is not cancelled', async () => {
    const ctl = controllableFetch()
    vi.stubGlobal('fetch', ctl.fn)
    const cache = new ImageCache(8)
    cache.prefetch('/x.jpg')
    const p = cache.load('/x.jpg')
    cache.cancelPrefetchesExcept([])
    expect(ctl.signal('/x.jpg')?.aborted).toBe(false)
    expect(ctl.fn).toHaveBeenCalledTimes(1)
    ctl.respond('/x.jpg')
    await expect(p).resolves.toBeDefined()
  })

  it('does not cache failed loads', async () => {
    const fetchFn: Mock<FetchFn> = vi.fn(async () => new Response('missing', { status: 404 }))
    vi.stubGlobal('fetch', fetchFn)
    const cache = new ImageCache(4)
    await expect(cache.load('/gone.jpg')).rejects.toThrow('Image file not found.')
    expect(cache.size).toBe(0)
    await expect(cache.load('/gone.jpg')).rejects.toThrow()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('reports decode failures and other HTTP errors', async () => {
    okFetch()
    decodeFails = true
    const cache = new ImageCache(4)
    await expect(cache.load('/bad.jpg')).rejects.toThrow('This image could not be decoded by the browser.')
    expect(cache.size).toBe(0)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await expect(cache.load('/err.jpg')).rejects.toThrow('Image request failed (500).')
  })

  it('swallows prefetch failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    const cache = new ImageCache(4)
    cache.prefetch('/missing.jpg')
    await flush()
    expect(cache.size).toBe(0)
  })

  it("a caller's abort signal only cancels its own wait", async () => {
    const ctl = controllableFetch()
    vi.stubGlobal('fetch', ctl.fn)
    const cache = new ImageCache(4)
    const controller = new AbortController()
    const mine = cache.load('/a.jpg', controller.signal)
    const other = cache.load('/a.jpg')
    controller.abort()
    await expect(mine).rejects.toMatchObject({ name: 'AbortError' })
    expect(ctl.signal('/a.jpg')?.aborted).toBe(false)
    ctl.respond('/a.jpg')
    await expect(other).resolves.toBeDefined()

    const aborted = new AbortController()
    aborted.abort()
    await expect(cache.load('/a.jpg', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('invalidate() drops an entry and closes its bitmap unless pinned', async () => {
    okFetch()
    const cache = new ImageCache(4)
    const a = await cache.load('/a.jpg')
    cache.invalidate('/a.jpg')
    expect(cache.get('/a.jpg')).toBeUndefined()
    expect((a as unknown as FakeBitmap).close).toHaveBeenCalledTimes(1)

    const b = await cache.load('/b.jpg')
    cache.pin('/b.jpg')
    cache.invalidate('/b.jpg')
    expect(cache.get('/b.jpg')).toBeUndefined()
    expect((b as unknown as FakeBitmap).close).not.toHaveBeenCalled()
    cache.invalidate('/unknown.jpg')
  })

  it('clear() empties the cache', async () => {
    okFetch()
    const cache = new ImageCache(4)
    const a = await cache.load('/a.jpg')
    await cache.load('/b.jpg')
    cache.clear()
    expect(cache.size).toBe(0)
    expect((a as unknown as FakeBitmap).close).toHaveBeenCalled()
  })
})
