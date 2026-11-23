import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiError } from '@/lib/api'
import type { AnnotationDoc, ImageItem, SaveAnnotationBody, SaveAnnotationResult } from '@/lib/types'
import { useAnnotationDoc, type DocOptions } from './useAnnotationDoc'
import { docHistoryCache } from './historyCache'

const getAnnotation = vi.fn<(pid: number, iid: number) => Promise<AnnotationDoc>>()
const saveAnnotation = vi.fn<(pid: number, iid: number, body: SaveAnnotationBody) => Promise<SaveAnnotationResult>>()

vi.mock('@/lib/endpoints', () => ({
  getAnnotation: (pid: number, iid: number) => getAnnotation(pid, iid),
  saveAnnotation: (pid: number, iid: number, body: SaveAnnotationBody) => saveAnnotation(pid, iid, body),
  restoreRevision: vi.fn(),
}))

const image: ImageItem = {
  id: 5,
  filename: 'a.jpg',
  rel_path: 'a.jpg',
  position: 0,
  status: 'in_progress',
  box_count: 1,
  class_ids: [1],
  assignee: null,
  flagged: false,
  comment_count: 0,
  open_comment_count: 0,
  last_editor: null,
  updated_at: null,
}

const serverDoc: AnnotationDoc = {
  version: 'v1',
  boxes: [{ id: 'a', class_id: 1, raw_label: null, x1: 0, y1: 0, x2: 10, y2: 10 }],
  readonly_reason: null,
  updated_at: null,
  updated_by: null,
}

const options: DocOptions = { canSave: true, forceAllowed: true, autosave: false, autosaveDelayMs: 800 }

function setup(opts: DocOptions = options) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  return { ...renderHook(({ o }) => useAnnotationDoc(1, 5, o), { wrapper, initialProps: { o: opts } }), qc }
}

beforeEach(() => {
  docHistoryCache.clear()
  getAnnotation.mockReset().mockResolvedValue(serverDoc)
  saveAnnotation.mockReset().mockResolvedValue({ version: 'v2', updated_at: '2026-11-23T10:00:00Z', box_count: 1, image, boxes: [] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAnnotationDoc', () => {
  it('loads the document', async () => {
    const { result } = setup()
    await waitFor(() => expect(result.current.ready).toBe(true))
    expect(result.current.boxes).toHaveLength(1)
    expect(result.current.state.baseVersion).toBe('v1')
  })

  it('flush() saves pending changes with the base version and resolves true', async () => {
    const { result } = setup()
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.commit([...result.current.boxes, { id: 'b', classId: 1, rawLabel: null, x1: 1, y1: 1, x2: 5, y2: 5 }]))
    expect(result.current.state.dirty).toBe(true)
    let ok = false
    await act(async () => {
      ok = await result.current.flush()
    })
    expect(ok).toBe(true)
    expect(saveAnnotation).toHaveBeenCalledTimes(1)
    const body = saveAnnotation.mock.calls[0]![2]
    expect(body.base_version).toBe('v1')
    expect(body.boxes.map((b) => b.id)).toEqual(['a', 'b'])
    expect(body.force).toBeUndefined()
    expect(result.current.state.save).toBe('saved')
    expect(result.current.state.baseVersion).toBe('v2')
  })

  it('after a save the annotation cache holds the server-normalised boxes, the editor stays clean', async () => {
    const stored = { id: 'a', class_id: 1, raw_label: null, x1: 0, y1: 0, x2: 12.5, y2: 10, difficult: false, truncated: false }
    saveAnnotation.mockResolvedValueOnce({ version: 'v2', updated_at: '2026-11-23T10:00:00Z', box_count: 1, image, boxes: [stored] })
    const { result, qc } = setup()
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.commit(result.current.boxes.map((b) => ({ ...b, x2: 12.5000001 }))))
    await act(async () => {
      await result.current.flush()
    })
    expect(qc.getQueryData<AnnotationDoc>(['project', 1, 'annotation', 5])?.boxes).toEqual([stored])
    expect(result.current.state.dirty).toBe(false)
    expect(result.current.state.save).toBe('saved')
  })

  it('flush() resolves false on a failed save (navigation must be cancelled)', async () => {
    saveAnnotation.mockRejectedValueOnce(new ApiError(0, 'network_error', 'offline'))
    const { result } = setup()
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.commit(result.current.boxes.map((b) => ({ ...b, x2: 20 }))))
    let ok = true
    await act(async () => {
      ok = await result.current.flush()
    })
    expect(ok).toBe(false)
    expect(result.current.state.save).toBe('error')
    expect(result.current.state.dirty).toBe(true)
  })

  it('a 409 conflict opens the conflict state; "keep mine" re-saves with force on their version', async () => {
    const theirs: AnnotationDoc = { ...serverDoc, version: 'v9', boxes: [] }
    saveAnnotation.mockRejectedValueOnce(new ApiError(409, 'conflict', 'Version mismatch', { current: theirs }))
    const { result } = setup()
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.commit(result.current.boxes.map((b) => ({ ...b, x2: 30 }))))
    let ok = true
    await act(async () => {
      ok = await result.current.flush()
    })
    expect(ok).toBe(false)
    expect(result.current.state.save).toBe('conflict')
    expect(result.current.state.conflict).toEqual(theirs)

    await act(async () => {
      await result.current.keepMine()
    })
    const body = saveAnnotation.mock.calls[1]![2]
    expect(body.base_version).toBe('v9')
    expect(body.force).toBe(true)
    expect(body.boxes[0]?.x2).toBe(30)
    expect(result.current.state.save).toBe('saved')
  })

  it('"load theirs" replaces my boxes without saving', async () => {
    const theirs: AnnotationDoc = { ...serverDoc, version: 'v9', boxes: [] }
    saveAnnotation.mockRejectedValueOnce(new ApiError(409, 'conflict', 'Version mismatch', { current: theirs }))
    const { result } = setup()
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.commit([]))
    await act(async () => {
      await result.current.flush()
    })
    act(() => result.current.resolveTheirs())
    expect(result.current.boxes).toEqual([])
    expect(result.current.state.save).toBe('saved')
    expect(result.current.state.baseVersion).toBe('v9')
    expect(saveAnnotation).toHaveBeenCalledTimes(1)
  })

  it('autosaves after the configured delay', async () => {
    const { result } = setup({ ...options, autosave: true, autosaveDelayMs: 800 })
    await waitFor(() => expect(result.current.ready).toBe(true))
    vi.useFakeTimers()
    act(() => result.current.commit(result.current.boxes.map((b) => ({ ...b, y2: 50 }))))
    await act(async () => {
      vi.advanceTimersByTime(700)
    })
    expect(saveAnnotation).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(150)
    })
    expect(saveAnnotation).toHaveBeenCalledTimes(1)
  })

  it('never saves when the user cannot save (read-only), but still lets navigation proceed', async () => {
    const { result, rerender } = setup()
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.commit([]))
    rerender({ o: { ...options, canSave: false } })
    let ok = false
    await act(async () => {
      ok = await result.current.flush()
    })
    expect(ok).toBe(true)
    expect(saveAnnotation).not.toHaveBeenCalled()
    expect(result.current.state.dirty).toBe(true)
  })

  it('a 423 lock error reports the holder', async () => {
    const holder = { id: 9, username: 'alice', display_name: 'Alice', avatar_color: '#3d8fd6' }
    saveAnnotation.mockRejectedValueOnce(new ApiError(423, 'locked', 'Alice is editing', { holder }))
    const onLocked = vi.fn()
    const { result } = setup({ ...options, onLocked })
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.commit([]))
    await act(async () => {
      await result.current.save()
    })
    expect(onLocked).toHaveBeenCalledWith(holder)
    expect(result.current.state.save).toBe('error')
  })
})
