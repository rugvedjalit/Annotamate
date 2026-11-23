import { beforeEach, describe, expect, it } from 'vitest'
import { useRealtime } from './realtime'

const alice = { id: 1, username: 'alice', display_name: 'Alice', avatar_color: '#3b82f6' }
const bob = { id: 2, username: 'bob', display_name: 'Bob', avatar_color: '#f97316' }

describe('realtime store', () => {
  beforeEach(() => useRealtime.getState().reset())

  it('a presence snapshot replaces presence and drops locks seen before (lock.state frames follow it)', () => {
    const s = () => useRealtime.getState()
    s().setLock(10, alice)
    s().setLock(11, bob)
    s().setPresenceSnapshot(7, [{ user: alice, image_id: 10, image_filename: 'a.jpg' }])
    expect(s().locks).toEqual({})
    expect(s().presence).toEqual({ 1: { user: alice, imageId: 10, imageFilename: 'a.jpg' } })
    s().setLock(10, alice)
    expect(s().locks).toEqual({ 10: alice })
  })

  it('presence updates carry the image filename and remove people who left', () => {
    const s = () => useRealtime.getState()
    s().setPresenceSnapshot(7, [])
    s().updatePresence(7, bob, 12, 'b.jpg', false)
    expect(s().presence[2]).toEqual({ user: bob, imageId: 12, imageFilename: 'b.jpg' })
    s().updatePresence(8, bob, 13, 'c.jpg', false) // another project: ignored
    expect(s().presence[2]?.imageId).toBe(12)
    s().updatePresence(7, bob, null, null, true)
    expect(s().presence).toEqual({})
  })
})
