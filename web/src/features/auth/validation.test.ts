import { describe, expect, it } from 'vitest'
import { generatePassword, safeNext, suggestUsername, validatePassword, validateSetupToken, validateUsername } from './validation'

describe('validateUsername', () => {
  it('accepts 3–32 chars of [a-z0-9_.-]', () => {
    expect(validateUsername('alice')).toBeNull()
    expect(validateUsername('a.b-c_1')).toBeNull()
    expect(validateUsername('x'.repeat(32))).toBeNull()
  })

  it('rejects empty, short, long and invalid names', () => {
    expect(validateUsername('')).toBe('Choose a username.')
    expect(validateUsername('ab')).toBe('Use 3 to 32 characters.')
    expect(validateUsername('x'.repeat(33))).toBe('Use 3 to 32 characters.')
    expect(validateUsername('Alice')).toMatch(/lowercase/)
    expect(validateUsername('al ice')).toMatch(/lowercase/)
    expect(validateUsername('al@ice')).toMatch(/lowercase/)
  })
})

describe('validatePassword', () => {
  it('requires at least 8 characters', () => {
    expect(validatePassword('1234567')).toBe('Use at least 8 characters.')
    expect(validatePassword('12345678')).toBeNull()
  })
})

describe('suggestUsername', () => {
  it('derives a valid username from a display name', () => {
    expect(suggestUsername('Alice Kim')).toBe('alice.kim')
    expect(suggestUsername('  José   Núñez ')).toBe('jose.nunez')
    expect(suggestUsername("O'Brien!")).toBe('obrien')
    expect(suggestUsername('x'.repeat(40))).toHaveLength(32)
  })
})

describe('generatePassword', () => {
  it('generates passwords of the requested length without ambiguous characters', () => {
    const pw = generatePassword()
    expect(pw).toHaveLength(16)
    expect(pw).not.toMatch(/[01lIoO]/)
    expect(validatePassword(pw)).toBeNull()
    expect(generatePassword(24)).toHaveLength(24)
    expect(generatePassword()).not.toBe(generatePassword())
  })
})

describe('safeNext', () => {
  it('allows in-app paths', () => {
    expect(safeNext('/p/1/annotate/5?status=todo')).toBe('/p/1/annotate/5?status=todo')
    expect(safeNext('/messages')).toBe('/messages')
  })

  it('blocks open redirects and auth pages', () => {
    expect(safeNext(null)).toBe('/')
    expect(safeNext('')).toBe('/')
    expect(safeNext('https://evil.example')).toBe('/')
    expect(safeNext('//evil.example')).toBe('/')
    expect(safeNext('/\\evil.example')).toBe('/')
    expect(safeNext('javascript:alert(1)')).toBe('/')
    expect(safeNext('/login?next=/x')).toBe('/')
    expect(safeNext('/setup')).toBe('/')
  })
})

describe('validateSetupToken', () => {
  it('requires a non-blank token', () => {
    expect(validateSetupToken('  ')).not.toBeNull()
    expect(validateSetupToken('abc123')).toBeNull()
  })
})
