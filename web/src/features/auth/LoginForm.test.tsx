import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setUnauthorizedHandler } from '@/lib/api'
import { BASE_URL } from '@/lib/config'
import type { User } from '@/lib/types'
import { LoginForm } from './LoginPage'

type FetchFn = (input: string, init: RequestInit) => Promise<Response>

const user: User = {
  id: 1,
  username: 'alice',
  display_name: 'Alice Kim',
  avatar_color: '#2b6ca3',
  email: null,
  is_admin: true,
  is_active: true,
  created_at: '2026-11-23T10:00:00Z',
  last_seen_at: null,
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('LoginForm', () => {
  let fetchMock: Mock<FetchFn>
  let onUnauthorized: Mock<() => void>

  beforeEach(() => {
    fetchMock = vi.fn<FetchFn>()
    vi.stubGlobal('fetch', fetchMock)
    onUnauthorized = vi.fn()
    setUnauthorizedHandler(onUnauthorized)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setUnauthorizedHandler(null)
  })

  function setup() {
    const onSuccess = vi.fn<(u: User) => void>()
    const ue = userEvent.setup()
    render(<LoginForm onSuccess={onSuccess} />)
    return {
      onSuccess,
      ue,
      username: screen.getByLabelText('Username') as HTMLInputElement,
      password: screen.getByLabelText('Password') as HTMLInputElement,
      submit: screen.getByRole('button', { name: 'Sign in' }),
    }
  }

  it('renders labelled fields with the right autocomplete hints', () => {
    const { username, password } = setup()
    expect(username).toHaveAttribute('autocomplete', 'username')
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveAttribute('autocomplete', 'current-password')
  })

  it('validates empty fields without calling the server', async () => {
    const { ue, submit, username, password } = setup()
    await ue.click(submit)
    expect(screen.getByText('Enter your username.')).toBeInTheDocument()
    expect(screen.getByText('Enter your password.')).toBeInTheDocument()
    expect(username).toHaveAttribute('aria-invalid', 'true')
    expect(password).toHaveAttribute('aria-invalid', 'true')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a whitespace-only username as empty', async () => {
    const { ue, submit, username, password } = setup()
    await ue.type(username, '   ')
    await ue.type(password, 'secret123')
    await ue.click(submit)
    expect(screen.getByText('Enter your username.')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts trimmed, lowercased credentials with the CSRF header and reports success', async () => {
    fetchMock.mockResolvedValue(json(user))
    const { ue, submit, username, password, onSuccess } = setup()
    await ue.type(username, '  Alice ')
    await ue.type(password, 'secret123')
    await ue.click(submit)
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(user))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`${BASE_URL}api/auth/login`)
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    const headers = init.headers as Record<string, string>
    expect(headers['X-Annotamate-Client']).toBe('web')
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(init.body))).toEqual({ username: 'alice', password: 'secret123' })
  })

  it('submits with Enter', async () => {
    fetchMock.mockResolvedValue(json(user))
    const { ue, username, password, onSuccess } = setup()
    await ue.type(username, 'alice')
    await ue.type(password, 'secret123{Enter}')
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1))
  })

  it('shows invalid credentials, clears the password and does not end the session', async () => {
    fetchMock.mockResolvedValue(json({ detail: 'Invalid username or password', code: 'invalid_credentials' }, 401))
    const { ue, submit, username, password, onSuccess } = setup()
    await ue.type(username, 'alice')
    await ue.type(password, 'wrongpass')
    await ue.click(submit)
    expect(await screen.findByText('Incorrect username or password.')).toHaveAttribute('role', 'alert')
    expect(password.value).toBe('')
    expect(username.value).toBe('alice')
    expect(onSuccess).not.toHaveBeenCalled()
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('shows the rate-limit message on 429', async () => {
    fetchMock.mockResolvedValue(json({ detail: 'Too many attempts', code: 'rate_limited' }, 429))
    const { ue, submit, username, password } = setup()
    await ue.type(username, 'alice')
    await ue.type(password, 'secret123')
    await ue.click(submit)
    expect(await screen.findByText('Too many failed attempts. Wait a few minutes, then try again.')).toHaveAttribute(
      'role',
      'alert',
    )
  })

  it('shows a connection error when the server is unreachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const { ue, submit, username, password } = setup()
    await ue.type(username, 'alice')
    await ue.type(password, 'secret123')
    await ue.click(submit)
    expect(await screen.findByText(/cannot reach the server/i)).toHaveAttribute('role', 'alert')
  })

  it('clears the previous error on a new attempt', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'x', code: 'invalid_credentials' }, 401))
    fetchMock.mockResolvedValueOnce(json(user))
    const { ue, submit, username, password, onSuccess } = setup()
    await ue.type(username, 'alice')
    await ue.type(password, 'nope-nope')
    await ue.click(submit)
    await screen.findByText('Incorrect username or password.')
    await ue.type(password, 'secret123')
    await ue.click(submit)
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(user))
    expect(screen.queryByText('Incorrect username or password.')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
