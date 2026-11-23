import { useEffect, useState } from 'react'
import { imageCache, type DecodedImage } from '@/lib/imageCache'
import { isAbortError } from '@/lib/api'

interface Result {
  image: DecodedImage | null
  error: string | null
  loading: boolean
  retry: () => void
}

interface State {
  url: string | null
  image: DecodedImage | null
  error: string | null
}

/** Decoded bitmap for a URL via the LRU image cache; pinned while on screen. */
export function useDecodedImage(url: string | null): Result {
  const [state, setState] = useState<State>(() => ({ url, image: url ? (imageCache.get(url) ?? null) : null, error: null }))
  const [nonce, setNonce] = useState(0)

  // New URL: show a cached bitmap immediately, otherwise clear until loaded.
  if (state.url !== url) {
    setState({ url, image: url ? (imageCache.get(url) ?? null) : null, error: null })
  }

  useEffect(() => {
    if (!url) return
    const unpin = imageCache.pin(url)
    if (imageCache.get(url)) return unpin
    const ctrl = new AbortController()
    imageCache
      .load(url, ctrl.signal)
      .then((image) => setState((s) => (s.url === url ? { url, image, error: null } : s)))
      .catch((err: unknown) => {
        if (isAbortError(err)) return
        setState((s) =>
          s.url === url ? { url, image: null, error: err instanceof Error ? err.message : 'The image could not be loaded.' } : s,
        )
      })
    return () => {
      ctrl.abort()
      unpin()
    }
  }, [url, nonce])

  const current = state.url === url ? state : { url, image: null, error: null }
  return {
    image: current.image,
    error: current.error,
    loading: !!url && !current.image && !current.error,
    retry: () => {
      if (url) imageCache.invalidate(url)
      setState({ url, image: null, error: null })
      setNonce((n) => n + 1)
    },
  }
}
