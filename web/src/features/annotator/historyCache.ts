// Per-image document states (with their undo/redo stacks) for the last 20 visited images, in memory.
import type { DocState } from './docReducer'

export const HISTORY_CACHE_SIZE = 20

export class DocHistoryCache {
  private readonly map = new Map<string, DocState>()
  private readonly max: number

  constructor(max = HISTORY_CACHE_SIZE) {
    this.max = max
  }

  put(key: string, state: DocState): void {
    this.map.delete(key)
    this.map.set(key, state)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      this.map.delete(oldest)
    }
  }

  get(key: string): DocState | undefined {
    return this.map.get(key)
  }

  /** Apply an update to a cached (not displayed) state, e.g. a save that finished after navigating away. */
  update(key: string, fn: (s: DocState) => DocState): void {
    const s = this.map.get(key)
    if (s) this.map.set(key, fn(s))
  }

  delete(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

export const docHistoryCache = new DocHistoryCache()
