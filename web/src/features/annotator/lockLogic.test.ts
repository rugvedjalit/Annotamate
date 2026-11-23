import { describe, expect, it } from 'vitest'
import type { UserBrief } from '@/lib/types'
import { reactToLockExpired, reactToLockState } from './lockLogic'

const other: UserBrief = { id: 2, username: 'bo', display_name: 'Bo', avatar_color: '#000000' }
const me: UserBrief = { id: 1, username: 'al', display_name: 'Al', avatar_color: '#000000' }

describe('reactToLockState', () => {
  it('re-acquires when the holder left while we waited', () => {
    expect(reactToLockState('denied', null, 1)).toEqual({ kind: 'reacquire' })
    expect(reactToLockState('revoked', null, 1)).toEqual({ kind: 'reacquire' })
  })
  it('treats a free lock as lost when we thought we held it', () => {
    expect(reactToLockState('held', null, 1)).toEqual({ kind: 'reacquire' })
  })
  it('ignores a free lock while still acquiring', () => {
    expect(reactToLockState('acquiring', null, 1)).toEqual({ kind: 'none' })
  })
  it('drops to read-only when someone else holds it', () => {
    expect(reactToLockState('acquiring', other, 1)).toEqual({ kind: 'denied', holder: other })
    expect(reactToLockState('held', other, 1)).toEqual({ kind: 'denied', holder: other })
  })
  it('ignores our own holder entry', () => {
    expect(reactToLockState('held', me, 1)).toEqual({ kind: 'none' })
  })
})

describe('reactToLockExpired', () => {
  it('re-acquires only while we believe we hold it', () => {
    expect(reactToLockExpired('held')).toEqual({ kind: 'reacquire' })
    expect(reactToLockExpired('denied')).toEqual({ kind: 'none' })
    expect(reactToLockExpired('acquiring')).toEqual({ kind: 'none' })
  })
})
