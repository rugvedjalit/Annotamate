import { useEffect, useState, type RefObject } from 'react'

/** Width of an element, tracked with ResizeObserver (0 until measured). */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

/** Debounced copy of a value. */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}
