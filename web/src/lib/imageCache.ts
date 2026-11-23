// Decoded image cache: fetch → createImageBitmap, LRU (8 entries), neighbour prefetch, abort on navigation.

export type DecodedImage = ImageBitmap | HTMLImageElement

interface Entry {
  url: string
  promise: Promise<DecodedImage>
  image: DecodedImage | null
  controller: AbortController
  prefetch: boolean
  lastUsed: number
}

async function decode(url: string, signal: AbortSignal): Promise<DecodedImage> {
  const res = await fetch(url, { credentials: 'same-origin', signal })
  if (!res.ok) throw new Error(res.status === 404 ? 'Image file not found.' : `Image request failed (${res.status}).`)
  const blob = await res.blob()
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob)
    } catch {
      throw new Error('This image could not be decoded by the browser.')
    }
  }
  const objectUrl = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = objectUrl
    await img.decode()
    return img
  } catch {
    throw new Error('This image could not be decoded by the browser.')
  } finally {
    // The decoded element keeps its pixels; the blob URL is no longer needed.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
  }
}

function release(image: DecodedImage | null): void {
  if (image && 'close' in image && typeof image.close === 'function') image.close()
}

export class ImageCache {
  private readonly entries = new Map<string, Entry>()
  private readonly pinned = new Map<string, number>()
  private clock = 0
  private readonly max: number

  constructor(max = 8) {
    this.max = max
  }

  /** Synchronously available decoded image (already loaded), or undefined. */
  get(url: string): DecodedImage | undefined {
    const e = this.entries.get(url)
    if (!e?.image) return undefined
    e.lastUsed = ++this.clock
    return e.image
  }

  /** Load (or join an in-flight load of) an image. The caller's signal only cancels its own wait. */
  load(url: string, signal?: AbortSignal): Promise<DecodedImage> {
    const entry = this.ensure(url, false)
    if (!signal) return entry.promise
    return new Promise<DecodedImage>((resolve, reject) => {
      const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort, { once: true })
      entry.promise.then(
        (img) => {
          signal.removeEventListener('abort', onAbort)
          resolve(img)
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(err)
        },
      )
    })
  }

  /** Start a low-priority background load; failures are ignored (retried on demand). */
  prefetch(url: string): void {
    if (this.entries.has(url)) return
    this.ensure(url, true).promise.catch(() => undefined)
  }

  /** Abort in-flight prefetches that are no longer wanted (e.g. after navigating far away). */
  cancelPrefetchesExcept(keep: Iterable<string>): void {
    const keepSet = new Set(keep)
    for (const [url, e] of this.entries) {
      if (e.prefetch && !e.image && !keepSet.has(url) && !this.pinned.has(url)) {
        e.controller.abort()
        this.entries.delete(url)
      }
    }
  }

  /** Pinned images (the one on screen) are never evicted. */
  pin(url: string): () => void {
    this.pinned.set(url, (this.pinned.get(url) ?? 0) + 1)
    return () => {
      const n = (this.pinned.get(url) ?? 1) - 1
      if (n <= 0) this.pinned.delete(url)
      else this.pinned.set(url, n)
      this.evict()
    }
  }

  /** Drop a cached image (e.g. the file changed on the server). */
  invalidate(url: string): void {
    const e = this.entries.get(url)
    if (!e) return
    this.entries.delete(url)
    if (!e.image) e.controller.abort()
    else if (!this.pinned.has(url)) release(e.image)
  }

  clear(): void {
    for (const e of this.entries.values()) {
      if (!e.image) e.controller.abort()
      else if (!this.pinned.has(e.url)) release(e.image)
    }
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }

  private ensure(url: string, prefetch: boolean): Entry {
    const existing = this.entries.get(url)
    if (existing) {
      existing.lastUsed = ++this.clock
      if (!prefetch) existing.prefetch = false
      return existing
    }
    const controller = new AbortController()
    const entry: Entry = {
      url,
      controller,
      prefetch,
      image: null,
      lastUsed: ++this.clock,
      promise: Promise.resolve(null as unknown as DecodedImage),
    }
    entry.promise = decode(url, controller.signal).then(
      (img) => {
        if (this.entries.get(url) !== entry) {
          // Evicted/cancelled while loading.
          if (!this.pinned.has(url)) release(img)
          return img
        }
        entry.image = img
        this.evict()
        return img
      },
      (err: unknown) => {
        if (this.entries.get(url) === entry) this.entries.delete(url)
        throw err
      },
    )
    this.entries.set(url, entry)
    this.evict()
    return entry
  }

  private evict(): void {
    if (this.entries.size <= this.max) return
    const candidates = [...this.entries.values()]
      .filter((e) => e.image && !this.pinned.has(e.url))
      .sort((a, b) => a.lastUsed - b.lastUsed)
    for (const e of candidates) {
      if (this.entries.size <= this.max) break
      this.entries.delete(e.url)
      release(e.image)
    }
  }
}

export const imageCache = new ImageCache(8)
