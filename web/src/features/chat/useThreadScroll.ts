// Scroll behaviour for message threads: start at the bottom, stick to the bottom when new messages
// arrive (if the reader is there or sent the message), load older pages near the top while keeping the
// visible position, and expose a "jump to latest" state otherwise.
import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'

interface Options {
  /** The scrolling container. */
  ref: RefObject<HTMLDivElement | null>
  firstId: number | null
  lastId: number | null
  /** The newest message was sent by me (always scroll to it). */
  lastIsMine: boolean
  hasOlder: boolean
  loadingOlder: boolean
  loadOlder: () => void
}

const BOTTOM_SLACK = 48
const TOP_TRIGGER = 120

export function useThreadScroll({ ref, firstId, lastId, lastIsMine, hasOlder, loadingOlder, loadOlder }: Options) {
  const initialized = useRef(false)
  const prevFirst = useRef<number | null>(null)
  const prevLast = useRef<number | null>(null)
  const heightBeforeOlder = useRef<number | null>(null)
  const atBottomRef = useRef(true)
  const optsRef = useRef({ hasOlder, loadingOlder, loadOlder })
  const [atBottom, setAtBottom] = useState(true)
  const [seenLastId, setSeenLastId] = useState<number | null>(null)

  useLayoutEffect(() => {
    optsRef.current = { hasOlder, loadingOlder, loadOlder }
  })

  const requestOlder = useCallback(() => {
    const el = ref.current
    const o = optsRef.current
    if (!el || !o.hasOlder || o.loadingOlder) return
    heightBeforeOlder.current = el.scrollHeight
    o.loadOlder()
  }, [ref])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || firstId === null || lastId === null) return
    if (!initialized.current) {
      initialized.current = true
      el.scrollTop = el.scrollHeight
    } else {
      if (prevFirst.current !== firstId && heightBeforeOlder.current !== null) {
        el.scrollTop += el.scrollHeight - heightBeforeOlder.current
        heightBeforeOlder.current = null
      }
      if (prevLast.current !== lastId && (lastIsMine || atBottomRef.current)) el.scrollTop = el.scrollHeight
    }
    prevFirst.current = firstId
    prevLast.current = lastId
    // Short threads: keep loading older pages until the viewport is filled.
    if (el.scrollHeight <= el.clientHeight + 8) requestOlder()
  }, [ref, firstId, lastId, lastIsMine, requestOlder])

  const onScroll = useCallback(() => {
    const el = ref.current
    if (!el) return
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK
    atBottomRef.current = bottom
    setAtBottom(bottom)
    if (bottom) setSeenLastId(prevLast.current)
    if (el.scrollTop < TOP_TRIGGER) requestOlder()
  }, [ref, requestOlder])

  const jumpToLatest = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setSeenLastId(prevLast.current)
  }, [ref])

  return {
    onScroll,
    jumpToLatest,
    /** New messages arrived below the fold. */
    showJump: !atBottom && lastId !== null && lastId !== seenLastId,
    atBottom,
  }
}
