// Runtime configuration injected by the server at `<!--annotamate:config-->` in index.html.

declare global {
  interface Window {
    __ANNOTAMATE__?: { baseUrl?: string }
  }
}

export function normalizeBaseUrl(value: string | undefined | null): string {
  let base = (value ?? '/').trim() || '/'
  if (!base.startsWith('/')) base = `/${base}`
  if (!base.endsWith('/')) base = `${base}/`
  return base
}

/** Always starts and ends with "/", e.g. "/" or "/annotamate/". */
export const BASE_URL = normalizeBaseUrl(typeof window !== 'undefined' ? window.__ANNOTAMATE__?.baseUrl : '/')

/** React Router basename (no trailing slash except for the root). */
export const ROUTER_BASENAME = BASE_URL === '/' ? '/' : BASE_URL.slice(0, -1)

export function apiUrl(path: string): string {
  return `${BASE_URL}api/${path.replace(/^\/+/, '')}`
}

/** URL of a file served relative to the base URL (brand assets, `ImageDetail.file_url`). */
export function assetUrl(path: string): string {
  return `${BASE_URL}${path.replace(/^\/+/, '')}`
}

export function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}${BASE_URL}api/ws`
}

export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent)

export const CREDIT_LINE = 'Annotamate · Created by Rugved Jalit'
