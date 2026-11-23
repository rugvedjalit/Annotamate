// Test helpers (imported only by *.test.ts files): a recording stand-in for CanvasRenderingContext2D.

export interface RecordedCall {
  name: string
  args: unknown[]
}

export interface MockContext {
  ctx: CanvasRenderingContext2D
  calls: RecordedCall[]
  /** Property assignments in order, e.g. ["fillStyle", "#fff"]. */
  sets: Array<[string, unknown]>
  count(name: string): number
  clear(): void
}

/**
 * Every method is a recording no-op; measureText returns 6 px per character; property writes
 * are recorded and readable.
 */
export function createMockContext(canvas?: HTMLCanvasElement, opts: { roundRect?: boolean } = {}): MockContext {
  const calls: RecordedCall[] = []
  const sets: Array<[string, unknown]> = []
  const props: Record<string | symbol, unknown> = {
    canvas: canvas ?? { width: 800, height: 600, ownerDocument: null },
    lineDash: [],
  }
  const fns = new Map<string | symbol, (...args: unknown[]) => unknown>()
  const handler: ProxyHandler<object> = {
    get(_t, key) {
      if (key in props) return props[key]
      if (key === 'roundRect' && opts.roundRect === false) return undefined
      if (key === 'then') return undefined
      let fn = fns.get(key)
      if (!fn) {
        const name = String(key)
        fn = (...args: unknown[]) => {
          calls.push({ name, args })
          if (name === 'measureText') return { width: String(args[0]).length * 6 }
          if (name === 'createPattern') return { pattern: true }
          if (name === 'getLineDash') return props.lineDash
          if (name === 'setLineDash') props.lineDash = args[0]
          return undefined
        }
        fns.set(key, fn)
      }
      return fn
    },
    set(_t, key, value) {
      props[key] = value
      sets.push([String(key), value])
      return true
    },
  }
  const ctx = new Proxy({}, handler) as CanvasRenderingContext2D
  return {
    ctx,
    calls,
    sets,
    count: (name) => calls.filter((c) => c.name === name).length,
    clear: () => {
      calls.length = 0
      sets.length = 0
    },
  }
}
