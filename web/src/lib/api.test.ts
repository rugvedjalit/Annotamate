import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  ApiError,
  apiRequest,
  buildQuery,
  errorMessage,
  http,
  isAbortError,
  isApiError,
  parseApiError,
  setUnauthorizedHandler,
} from './api'
import { BASE_URL } from './config'

describe('parseApiError', () => {
  it('reads a conforming body and keeps extra fields', () => {
    const current = { version: 'abc', boxes: [] }
    const err = parseApiError(409, { detail: 'Someone else saved this image', code: 'conflict', current })
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(409)
    expect(err.code).toBe('conflict')
    expect(err.detail).toBe('Someone else saved this image')
    expect(err.message).toBe('Someone else saved this image')
    expect(err.extra).toEqual({ current })
  })

  it('keeps lock holders and other extras', () => {
    const holder = { id: 2, username: 'alice', display_name: 'Alice', avatar_color: '#123456' }
    const err = parseApiError(423, { detail: 'Alice is editing', code: 'locked', holder })
    expect(err.code).toBe('locked')
    expect(err.extra.holder).toEqual(holder)
  })

  it('handles the framework-style validation array', () => {
    const detail = [
      { loc: ['body', 'username'], msg: 'String too short', type: 'string_too_short' },
      { loc: ['body', 'password'], msg: 'Field required', type: 'missing' },
    ]
    const err = parseApiError(422, { detail })
    expect(err.code).toBe('validation_error')
    expect(err.detail).toBe('String too short')
    expect(err.extra.errors).toEqual(detail)
    expect(err.fieldErrors()).toEqual({ username: 'String too short', password: 'Field required' })
  })

  it('keeps an explicit errors list over the detail array', () => {
    const errors = [{ loc: ['body', 'name'], msg: 'Taken' }]
    const err = parseApiError(422, { detail: [{ msg: 'Invalid' }], code: 'validation_error', errors })
    expect(err.detail).toBe('Invalid')
    expect(err.extra.errors).toBe(errors)
  })

  it('falls back to default codes and messages per status', () => {
    expect(parseApiError(404, null)).toMatchObject({ code: 'not_found', detail: 'Not found.' })
    expect(parseApiError(401, undefined)).toMatchObject({ code: 'unauthenticated' })
    expect(parseApiError(403, {})).toMatchObject({ code: 'forbidden' })
    expect(parseApiError(413, '')).toMatchObject({ code: 'too_large' })
    expect(parseApiError(429, [1, 2])).toMatchObject({ code: 'rate_limited' })
    expect(parseApiError(400, { detail: '  ', code: '' })).toMatchObject({
      code: 'bad_request',
      detail: 'The request was not valid.',
    })
    expect(parseApiError(418, {})).toMatchObject({ code: 'http_error', detail: 'Request failed (418).' })
  })

  it('never shows raw server pages for 5xx errors', () => {
    const err = parseApiError(502, '<html><body>Bad gateway</body></html>')
    expect(err.code).toBe('server_error')
    expect(err.detail).toBe('The server ran into a problem. Please try again.')
    expect(parseApiError(500, { detail: 'Database is locked', code: 'server_error' }).detail).toBe('Database is locked')
  })
})

describe('ApiError helpers', () => {
  it('fieldErrors keeps the first message per field and skips junk entries', () => {
    const err = new ApiError(422, 'validation_error', 'Invalid', {
      errors: [{ loc: ['body', 'name'], msg: 'first' }, { loc: ['body', 'name'], msg: 'second' }, 'junk', { loc: [], msg: 'general' }, { loc: ['x'] }],
    })
    expect(err.fieldErrors()).toEqual({ name: 'first', _: 'general' })
    expect(new ApiError(400, 'bad_request', 'x').fieldErrors()).toEqual({})
  })

  it('isNetworkError is true only for status 0', () => {
    expect(new ApiError(0, 'network_error', 'x').isNetworkError).toBe(true)
    expect(new ApiError(500, 'server_error', 'x').isNetworkError).toBe(false)
  })

  it('errorMessage prefers the API detail, then Error.message, then the fallback', () => {
    expect(errorMessage(new ApiError(409, 'conflict', 'Version mismatch'))).toBe('Version mismatch')
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage(new Error(''))).toBe('Something went wrong.')
    expect(errorMessage('oops')).toBe('Something went wrong.')
    expect(errorMessage(null, 'Custom')).toBe('Custom')
  })

  it('isApiError narrows and optionally checks the code', () => {
    const err: unknown = new ApiError(409, 'readonly', 'Read-only')
    expect(isApiError(err)).toBe(true)
    expect(isApiError(err, 'readonly')).toBe(true)
    expect(isApiError(err, 'conflict')).toBe(false)
    expect(isApiError(new Error('x'))).toBe(false)
  })

  it('isAbortError detects DOMException and Error aborts', () => {
    expect(isAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true)
    const e = new Error('aborted')
    e.name = 'AbortError'
    expect(isAbortError(e)).toBe(true)
    expect(isAbortError(new Error('x'))).toBe(false)
    expect(isAbortError('AbortError')).toBe(false)
  })
})

describe('buildQuery', () => {
  it('skips empty values and joins arrays', () => {
    expect(buildQuery(undefined)).toBe('')
    expect(buildQuery({})).toBe('')
    expect(buildQuery({ a: undefined, b: null, c: '', d: [] })).toBe('')
    const q = buildQuery({ a: 1, e: [1, 2], g: false, h: true, s: 'x y' })
    const params = new URLSearchParams(q.slice(1))
    expect(q.startsWith('?')).toBe(true)
    expect(params.get('a')).toBe('1')
    expect(params.get('e')).toBe('1,2')
    expect(params.get('g')).toBe('false')
    expect(params.get('h')).toBe('true')
    expect(params.get('s')).toBe('x y')
  })
})

describe('apiRequest', () => {
  type FetchArgs = [input: string, init: RequestInit]
  let fetchMock: Mock<(...args: FetchArgs) => Promise<Response>>

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }

  function lastCall(): { url: string; init: RequestInit; headers: Record<string, string> } {
    const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
    if (!call) throw new Error('fetch was not called')
    const [url, init] = call
    return { url, init, headers: (init.headers ?? {}) as Record<string, string> }
  }

  beforeEach(() => {
    fetchMock = vi.fn<(...args: FetchArgs) => Promise<Response>>()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setUnauthorizedHandler(null)
  })

  it('GETs JSON from the base URL with cookies and without the CSRF header', async () => {
    fetchMock.mockResolvedValue(json([{ id: 1 }]))
    const data = await http.get<{ id: number }[]>('projects', { query: { archived: false } })
    expect(data).toEqual([{ id: 1 }])
    const { url, init, headers } = lastCall()
    expect(url).toBe(`${BASE_URL}api/projects?archived=false`)
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('same-origin')
    expect(headers.Accept).toBe('application/json')
    expect(headers['X-Annotamate-Client']).toBeUndefined()
    expect(init.body).toBeUndefined()
  })

  it('strips leading slashes from paths', async () => {
    fetchMock.mockResolvedValue(json({}))
    await http.get('/me')
    expect(lastCall().url).toBe(`${BASE_URL}api/me`)
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('%s sends the CSRF header', async (method) => {
    fetchMock.mockResolvedValue(json({ ok: true }))
    await apiRequest(method, 'projects/1', { body: method === 'DELETE' ? undefined : { name: 'x' } })
    const { init, headers } = lastCall()
    expect(init.method).toBe(method)
    expect(headers['X-Annotamate-Client']).toBe('web')
    if (method !== 'DELETE') {
      expect(headers['Content-Type']).toBe('application/json')
      expect(init.body).toBe(JSON.stringify({ name: 'x' }))
    }
  })

  it('passes FormData through without a JSON content type', async () => {
    fetchMock.mockResolvedValue(json({ added: [], skipped: [] }))
    const form = new FormData()
    form.append('subdir', 'new')
    await http.post('projects/1/upload', form)
    const { init, headers } = lastCall()
    expect(init.body).toBe(form)
    expect(headers['Content-Type']).toBeUndefined()
    expect(headers['X-Annotamate-Client']).toBe('web')
  })

  it('returns undefined for 204 and empty bodies', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(http.post('auth/logout')).resolves.toBeUndefined()
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }))
    await expect(http.get('anything')).resolves.toBeUndefined()
  })

  it('throws ApiError with status, code, detail and extra for non-OK responses', async () => {
    const current = { version: 'v2', boxes: [], readonly_reason: null, updated_at: null, updated_by: null }
    fetchMock.mockResolvedValue(json({ detail: 'Conflict', code: 'conflict', current }, 409))
    const err = await http.put('projects/1/images/2/annotation', { base_version: 'v1', boxes: [] }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 409, code: 'conflict', detail: 'Conflict' })
    expect((err as ApiError).extra.current).toEqual(current)
  })

  it('handles non-JSON error bodies', async () => {
    fetchMock.mockResolvedValue(new Response('Bad Gateway', { status: 502 }))
    await expect(http.get('projects')).rejects.toMatchObject({ status: 502, code: 'server_error' })
  })

  it('calls the unauthorized handler on 401 unless skipAuthRedirect is set', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    fetchMock.mockImplementation(async () => json({ detail: 'Not signed in', code: 'unauthenticated' }, 401))
    await expect(http.get('me')).rejects.toMatchObject({ status: 401 })
    expect(handler).toHaveBeenCalledTimes(1)
    await expect(http.post('auth/login', { username: 'a', password: 'b' }, { skipAuthRedirect: true })).rejects.toMatchObject({
      status: 401,
    })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('does not call the unauthorized handler for other errors', async () => {
    const handler = vi.fn()
    setUnauthorizedHandler(handler)
    fetchMock.mockResolvedValue(json({ detail: 'Nope', code: 'forbidden' }, 403))
    await expect(http.get('projects/1')).rejects.toMatchObject({ code: 'forbidden' })
    expect(handler).not.toHaveBeenCalled()
  })

  it('maps network failures to a status-0 ApiError', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const err = await http.get('projects').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 0, code: 'network_error' })
    expect((err as ApiError).isNetworkError).toBe(true)
  })

  it('rethrows aborts unchanged', async () => {
    const abort = new DOMException('The operation was aborted.', 'AbortError')
    fetchMock.mockRejectedValue(abort)
    const controller = new AbortController()
    const err = await http.get('projects', { signal: controller.signal }).catch((e: unknown) => e)
    expect(err).toBe(abort)
    expect(lastCall().init.signal).toBe(controller.signal)
  })
})
