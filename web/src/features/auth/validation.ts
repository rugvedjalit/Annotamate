// Account field rules shared by setup, user administration and the account page.

export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/

export function validateUsername(v: string): string | null {
  if (!v) return 'Choose a username.'
  if (v.length < 3 || v.length > 32) return 'Use 3 to 32 characters.'
  if (!USERNAME_RE.test(v)) return 'Use lowercase letters, digits, "_", "." or "-".'
  return null
}

export function validatePassword(v: string): string | null {
  if (v.length < 8) return 'Use at least 8 characters.'
  return null
}

export function validateSetupToken(v: string): string | null {
  return v.trim() ? null : 'Enter the setup token from the server log.'
}

/** Suggest a username from a display name ("Alice Kim" → "alice.kim"). */
export function suggestUsername(displayName: string): string {
  return displayName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '.')
    .replace(/[^a-z0-9_.-]/g, '')
    .slice(0, 32)
}

/** A random password for admin-created accounts / resets (16 chars, no ambiguous characters). */
export function generatePassword(length = 16): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

/** Only allow same-app paths as redirect targets (prevents open redirects). */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
  if (next.startsWith('/login') || next.startsWith('/setup')) return '/'
  return next
}
