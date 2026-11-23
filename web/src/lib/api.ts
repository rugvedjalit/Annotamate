// Fetch wrapper: base URL, cookies, CSRF header, JSON, typed errors, 401 handling.
import { apiUrl } from './config'

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const DEFAULT_CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  422: 'validation_error',
  423: 'locked',
  429: 'rate_limited',
}

const DEFAULT_MESSAGES: Record<number, string> = {
  0: 'Cannot reach the server. Check your connection and try again.',
  400: 'The request was not valid.',
  401: 'Your session has expired. Please sign in again.',
  403: 'You do not have permission to do that.',
  404: 'Not found.',
  409: 'This conflicts with a newer change.',
  413: 'The upload is too large.',
  422: 'Some fields are not valid.',
  423: 'Someone else is editing this image.',
  429: 'Too many attempts. Please wait a moment and try again.',
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly detail: string
  readonly extra: Record<string, unknown>

  constructor(status: number, code: string, detail: string, extra: Record<string, unknown> = {}) {
    super(detail)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
    this.extra = extra
  }

  get isNetworkError(): boolean {
    return this.status === 0
  }

  /** Field errors for 422 responses, keyed by the last element of `loc`. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {}
    const errors = this.extra.errors
    if (!Array.isArray(errors)) return out
    for (const e of errors) {
      if (!e || typeof e !== 'object') continue
      const loc = (e as { loc?: unknown }).loc
      const msg = (e as { msg?: unknown }).msg
      const key = Array.isArray(loc) && loc.length ? String(loc[loc.length - 1]) : '_'
      if (typeof msg === 'string' && !(key in out)) out[key] = msg
    }
    return out
  }
}

function defaultCode(status: number): string {
  if (status === 0) return 'network_error'
  if (status >= 500) return 'server_error'
  return DEFAULT_CODES[status] ?? 'http_error'
}

function defaultMessage(status: number): string {
  if (status >= 500) return 'The server ran into a problem. Please try again.'
  return DEFAULT_MESSAGES[status] ?? `Request failed (${status}).`
}

/** Build an ApiError from a status code and a (possibly non-conforming) response body. */
export function parseApiError(status: number, body: unknown): ApiError {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const { detail, code, ...extra } = body as Record<string, unknown>
    let message: string
    if (typeof detail === 'string' && detail.trim()) {
      message = detail
    } else if (Array.isArray(detail)) {
      // Framework-default validation shape: detail = [{loc, msg, type}]
      const first: unknown = detail[0]
      message =
        first && typeof first === 'object' && typeof (first as { msg?: unknown }).msg === 'string'
          ? String((first as { msg: string }).msg)
          : defaultMessage(status)
      if (!('errors' in extra)) extra.errors = detail
    } else {
      message = defaultMessage(status)
    }
    return new ApiError(status, typeof code === 'string' && code ? code : defaultCode(status), message, extra)
  }
  return new ApiError(status, defaultCode(status), defaultMessage(status))
}

/** Human-readable message for any thrown value (for toasts). */
export function errorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (err instanceof ApiError) return err.detail
  if (err instanceof Error && err.message) return err.message
  return fallback
}

export function isApiError(err: unknown, code?: string): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code)
}

export function isAbortError(err: unknown): boolean {
  return (err instanceof DOMException || err instanceof Error) && err.name === 'AbortError'
}

export type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[]
export type Query = Record<string, QueryValue>

export interface RequestOptions {
  query?: Query
  body?: unknown
  signal?: AbortSignal
  /** Do not trigger the global "session expired" handler on 401 (login, auth state). */
  skipAuthRedirect?: boolean
}

let unauthorizedHandler: (() => void) | null = null

/** Registered by the app: clears the session and redirects to /login?next=… */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn
}

export function buildQuery(query: Query | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(','))
    } else {
      params.set(key, String(value))
    }
  }
  const s = params.toString()
  return s ? `?${s}` : ''
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '')
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

export async function apiRequest<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  let body: BodyInit | undefined
  if (MUTATING.has(method)) headers['X-Annotamate-Client'] = 'web'
  if (opts.body instanceof FormData) {
    body = opts.body
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }

  let res: Response
  try {
    res = await fetch(apiUrl(path) + buildQuery(opts.query), {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    })
  } catch (err) {
    if (isAbortError(err)) throw err
    throw new ApiError(0, 'network_error', defaultMessage(0))
  }

  if (!res.ok) {
    const error = parseApiError(res.status, await readBody(res))
    if (res.status === 401 && !opts.skipAuthRedirect) unauthorizedHandler?.()
    throw error
  }

  if (res.status === 204) return undefined as T
  const data = await readBody(res)
  return (data ?? undefined) as T
}

export const http = {
  get: <T>(path: string, opts?: RequestOptions) => apiRequest<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>('POST', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>('PUT', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => apiRequest<T>('PATCH', path, { ...opts, body }),
  delete: <T = void>(path: string, opts?: RequestOptions) => apiRequest<T>('DELETE', path, opts),
}
