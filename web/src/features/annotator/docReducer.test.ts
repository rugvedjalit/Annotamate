import { describe, expect, it } from 'vitest'
import type { AnnotationDoc, Box } from '@/lib/types'
import type { EditorBox } from '@/lib/boxes'
import { MAX_HISTORY, docReducer, initialDocState, type DocAction, type DocState } from './docReducer'
import { DocHistoryCache } from './historyCache'

const KEY = '1:10'

function apiBox(id: string, x = 10, classId: number | null = 1): Box {
  return { id, class_id: classId, raw_label: classId === null ? 'truck' : null, x1: x, y1: 10, x2: x + 20, y2: 40 }
}

function doc(boxes: Box[], version: string | null = 'v1', extra: Partial<AnnotationDoc> = {}): AnnotationDoc {
  return { version, boxes, readonly_reason: null, updated_at: '2026-11-23T10:00:00Z', updated_by: null, ...extra }
}

function run(state: DocState, ...actions: DocAction[]): DocState {
  return actions.reduce(docReducer, state)
}

function loaded(boxes: Box[] = [apiBox('a')], version: string | null = 'v1'): DocState {
  return run(initialDocState, { type: 'loadStart', key: KEY }, { type: 'loadSuccess', key: KEY, doc: doc(boxes, version) })
}

const moved = (s: DocState, dx = 5): EditorBox[] => s.boxes.map((b) => ({ ...b, x1: b.x1 + dx, x2: b.x2 + dx }))

describe('docReducer: loading', () => {
  it('starts clean after a load', () => {
    const s = loaded()
    expect(s.status).toBe('ready')
    expect(s.key).toBe(KEY)
    expect(s.baseVersion).toBe('v1')
    expect(s.dirty).toBe(false)
    expect(s.save).toBe('saved')
    expect(s.past).toEqual([])
    expect(s.boxes[0]).toMatchObject({ id: 'a', classId: 1, x1: 10 })
  })

  it('converts unknown labels (class_id null) with their raw label', () => {
    const s = loaded([apiBox('u', 0, null)])
    expect(s.boxes[0]).toMatchObject({ classId: null, rawLabel: 'truck' })
  })

  it('ignores results for another image', () => {
    const s = run(initialDocState, { type: 'loadStart', key: KEY }, { type: 'loadSuccess', key: '1:11', doc: doc([]) })
    expect(s.status).toBe('loading')
  })

  it('records load errors only while loading', () => {
    const err = new Error('boom')
    const failing = run(initialDocState, { type: 'loadStart', key: KEY }, { type: 'loadError', key: KEY, error: err })
    expect(failing.status).toBe('error')
    expect(failing.loadError).toBe(err)
    const ready = loaded()
    expect(docReducer(ready, { type: 'loadError', key: KEY, error: err })).toBe(ready)
  })

  it('keeps readonly_reason from the server', () => {
    const s = run(initialDocState, { type: 'loadStart', key: KEY }, {
      type: 'loadSuccess',
      key: KEY,
      doc: doc([], 'v1', { readonly_reason: 'segmentation lines' }),
    })
    expect(s.readonlyReason).toBe('segmentation lines')
  })
})

describe('docReducer: undo / redo and dirty tracking', () => {
  it('commit makes the doc dirty and records one history entry', () => {
    const s0 = loaded()
    const s1 = docReducer(s0, { type: 'commit', boxes: moved(s0) })
    expect(s1.dirty).toBe(true)
    expect(s1.save).toBe('dirty')
    expect(s1.past).toHaveLength(1)
    expect(s1.revision).toBe(s0.revision + 1)
  })

  it('committing the same array is a no-op', () => {
    const s0 = loaded()
    expect(docReducer(s0, { type: 'commit', boxes: s0.boxes })).toBe(s0)
  })

  it('visibility/lock changes are undoable but do not make the doc dirty', () => {
    const s0 = loaded()
    const s1 = docReducer(s0, { type: 'commit', boxes: s0.boxes.map((b) => ({ ...b, hidden: true, locked: true })) })
    expect(s1.past).toHaveLength(1)
    expect(s1.dirty).toBe(false)
    expect(s1.save).toBe('saved')
    expect(s1.revision).toBe(s0.revision)
    const s2 = docReducer(s1, { type: 'undo' })
    expect(s2.boxes[0]?.hidden).toBeUndefined()
  })

  it('undo returns to the saved state (clean) and redo re-applies', () => {
    const s0 = loaded()
    const s1 = docReducer(s0, { type: 'commit', boxes: moved(s0) })
    const s2 = docReducer(s1, { type: 'undo' })
    expect(s2.boxes).toBe(s0.boxes)
    expect(s2.dirty).toBe(false)
    expect(s2.save).toBe('saved')
    expect(s2.future).toHaveLength(1)
    const s3 = docReducer(s2, { type: 'redo' })
    expect(s3.boxes).toBe(s1.boxes)
    expect(s3.dirty).toBe(true)
    expect(s3.future).toHaveLength(0)
  })

  it('undo with an empty history does nothing (never deletes loaded boxes)', () => {
    const s0 = loaded()
    expect(docReducer(s0, { type: 'undo' })).toBe(s0)
    expect(docReducer(s0, { type: 'redo' })).toBe(s0)
  })

  it('a new change clears the redo stack', () => {
    const s0 = loaded()
    const s1 = run(s0, { type: 'commit', boxes: moved(s0) }, { type: 'undo' })
    expect(s1.future).toHaveLength(1)
    const s2 = docReducer(s1, { type: 'commit', boxes: moved(s1, 9) })
    expect(s2.future).toHaveLength(0)
  })

  it(`caps history at ${MAX_HISTORY} snapshots`, () => {
    let s = loaded()
    for (let i = 0; i < MAX_HISTORY + 15; i++) s = docReducer(s, { type: 'commit', boxes: moved(s, 1) })
    expect(s.past).toHaveLength(MAX_HISTORY)
  })

  it('covers create, delete, class change and property edits', () => {
    const s0 = loaded()
    const created = [...s0.boxes, { id: 'b', classId: 2, rawLabel: null, x1: 0, y1: 0, x2: 5, y2: 5 }]
    const s1 = docReducer(s0, { type: 'commit', boxes: created })
    const s2 = docReducer(s1, { type: 'commit', boxes: s1.boxes.map((b) => (b.id === 'b' ? { ...b, classId: 3 } : b)) })
    const s3 = docReducer(s2, { type: 'commit', boxes: s2.boxes.map((b) => ({ ...b, difficult: true })) })
    const s4 = docReducer(s3, { type: 'commit', boxes: s3.boxes.filter((b) => b.id !== 'a') })
    expect(s4.past).toHaveLength(4)
    const back = run(s4, { type: 'undo' }, { type: 'undo' }, { type: 'undo' }, { type: 'undo' })
    expect(back.boxes).toBe(s0.boxes)
    expect(back.dirty).toBe(false)
  })
})

describe('docReducer: save state machine', () => {
  it('saved → dirty → saving → saved', () => {
    const s0 = loaded()
    const s1 = docReducer(s0, { type: 'commit', boxes: moved(s0) })
    const s2 = docReducer(s1, { type: 'saveStart' })
    expect(s2.save).toBe('saving')
    const s3 = docReducer(s2, { type: 'saveSuccess', sent: s1.boxes, version: 'v2', updatedAt: null, updatedBy: null })
    expect(s3.save).toBe('saved')
    expect(s3.dirty).toBe(false)
    expect(s3.baseVersion).toBe('v2')
    // history survives a save
    expect(s3.past).toHaveLength(1)
  })

  it('edits made while saving keep the doc dirty after the save completes', () => {
    const s0 = loaded()
    const s1 = run(s0, { type: 'commit', boxes: moved(s0) }, { type: 'saveStart' })
    const sent = s1.boxes
    const s2 = docReducer(s1, { type: 'commit', boxes: moved(s1, 3) })
    expect(s2.save).toBe('saving')
    expect(s2.revision).toBe(s1.revision + 1)
    const s3 = docReducer(s2, { type: 'saveSuccess', sent, version: 'v2', updatedAt: null, updatedBy: null })
    expect(s3.save).toBe('dirty')
    expect(s3.dirty).toBe(true)
    expect(s3.baseVersion).toBe('v2')
  })

  it('undoing back to what the server has after a save is clean again', () => {
    const s0 = loaded()
    const s1 = run(s0, { type: 'commit', boxes: moved(s0) }, { type: 'saveStart' })
    const s2 = docReducer(s1, { type: 'saveSuccess', sent: s1.boxes, version: 'v2', updatedAt: null, updatedBy: null })
    const s3 = docReducer(s2, { type: 'undo' })
    expect(s3.dirty).toBe(true) // the server now has the moved version
    const s4 = docReducer(s3, { type: 'redo' })
    expect(s4.dirty).toBe(false)
    expect(s4.save).toBe('saved')
  })

  it('saving → error; the next edit returns to dirty (autosave retries)', () => {
    const s0 = loaded()
    const s1 = run(s0, { type: 'commit', boxes: moved(s0) }, { type: 'saveStart' }, { type: 'saveError', message: 'offline' })
    expect(s1.save).toBe('error')
    expect(s1.saveError).toBe('offline')
    expect(s1.dirty).toBe(true)
    const s2 = docReducer(s1, { type: 'commit', boxes: moved(s1) })
    expect(s2.save).toBe('dirty')
    expect(s2.saveError).toBeNull()
  })

  it('saving → conflict; edits keep the conflict until resolved', () => {
    const s0 = loaded()
    const theirs = doc([apiBox('x', 100), apiBox('y', 200)], 'v9')
    const s1 = run(s0, { type: 'commit', boxes: moved(s0) }, { type: 'saveStart' }, { type: 'saveConflict', current: theirs })
    expect(s1.save).toBe('conflict')
    expect(s1.conflict).toBe(theirs)
    const s2 = docReducer(s1, { type: 'commit', boxes: moved(s1) })
    expect(s2.save).toBe('conflict')
  })

  it('resolveTheirs loads the server copy (mine stays undoable)', () => {
    const s0 = loaded()
    const theirs = doc([apiBox('x', 100)], 'v9')
    const mine = moved(s0)
    const s1 = run(s0, { type: 'commit', boxes: mine }, { type: 'saveStart' }, { type: 'saveConflict', current: theirs })
    const s2 = docReducer(s1, { type: 'resolveTheirs' })
    expect(s2.save).toBe('saved')
    expect(s2.dirty).toBe(false)
    expect(s2.conflict).toBeNull()
    expect(s2.baseVersion).toBe('v9')
    expect(s2.boxes.map((b) => b.id)).toEqual(['x'])
    expect(s2.past[s2.past.length - 1]).toBe(mine)
  })

  it('resolveMine keeps my boxes, adopts their version as base and is dirty (ready to re-save)', () => {
    const s0 = loaded()
    const theirs = doc([apiBox('x', 100)], 'v9')
    const mine = moved(s0)
    const s1 = run(s0, { type: 'commit', boxes: mine }, { type: 'saveStart' }, { type: 'saveConflict', current: theirs })
    const s2 = docReducer(s1, { type: 'resolveMine' })
    expect(s2.boxes).toBe(mine)
    expect(s2.baseVersion).toBe('v9')
    expect(s2.conflict).toBeNull()
    expect(s2.dirty).toBe(true)
    expect(s2.save).toBe('dirty')
  })

  it('a read-only response marks the doc read-only and reports unsaved work as an error', () => {
    const s0 = loaded()
    const s1 = run(s0, { type: 'commit', boxes: moved(s0) }, { type: 'readonly', reason: 'Unsupported YOLO lines' })
    expect(s1.readonlyReason).toBe('Unsupported YOLO lines')
    expect(s1.save).toBe('error')
  })

  it('external changes are adopted only without local edits', () => {
    const s0 = loaded()
    const remote = doc([apiBox('r', 50)], 'v5')
    const adopted = docReducer(s0, { type: 'external', doc: remote })
    expect(adopted.baseVersion).toBe('v5')
    expect(adopted.boxes.map((b) => b.id)).toEqual(['r'])
    expect(adopted.past).toEqual([])
    const dirty = docReducer(s0, { type: 'commit', boxes: moved(s0) })
    expect(docReducer(dirty, { type: 'external', doc: remote })).toBe(dirty)
  })

  it('serverReplace (revision restore) is saved and undoable', () => {
    const s0 = loaded()
    const restored: EditorBox[] = [{ id: 'old', classId: 1, rawLabel: null, x1: 1, y1: 1, x2: 9, y2: 9 }]
    const s1 = docReducer(s0, { type: 'serverReplace', boxes: restored, version: 'v3', updatedAt: null, updatedBy: null })
    expect(s1.save).toBe('saved')
    expect(s1.dirty).toBe(false)
    expect(s1.baseVersion).toBe('v3')
    const s2 = docReducer(s1, { type: 'undo' })
    expect(s2.boxes).toBe(s0.boxes)
    expect(s2.dirty).toBe(true)
  })
})

describe('DocHistoryCache', () => {
  it('keeps the most recent 20 documents', () => {
    const cache = new DocHistoryCache(20)
    for (let i = 0; i < 25; i++) cache.put(`1:${i}`, loaded())
    expect(cache.size).toBe(20)
    expect(cache.get('1:0')).toBeUndefined()
    expect(cache.get('1:24')).toBeDefined()
  })

  it('refreshes recency on put and applies late updates', () => {
    const cache = new DocHistoryCache(2)
    const a = loaded()
    cache.put('a', a)
    cache.put('b', a)
    cache.put('a', a)
    cache.put('c', a)
    expect(cache.get('b')).toBeUndefined()
    cache.update('a', (s) => ({ ...s, baseVersion: 'v7' }))
    expect(cache.get('a')?.baseVersion).toBe('v7')
  })
})
