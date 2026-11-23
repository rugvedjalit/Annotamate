import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { qk } from '@/lib/queryKeys'
import type { Project, ProjectSummary, ServerMessageMap } from '@/lib/types'
import { useRealtime } from '@/stores/realtime'
import { applyClassMigrationEvent, CLASS_MIGRATION_LINGER_MS } from './classMigrationEvents'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

type Event = ServerMessageMap['classes.migration']

function event(extra: Partial<Event> = {}): Event {
  return { type: 'classes.migration', project_id: 7, kind: 'delete', class_name: 'truck', done: 0, total: 0, finished: false, ...extra }
}

function setup() {
  const qc = new QueryClient()
  qc.setQueryData(qk.project(7), { id: 7, name: 'Docks', class_migration: null } as Project)
  qc.setQueryData(qk.projects(false), [{ id: 7, class_migration: null }, { id: 8, class_migration: null }] as ProjectSummary[])
  qc.setQueryData(qk.annotation(7, 3), { version: 'v1' })
  qc.setQueryData(qk.annotation(8, 3), { version: 'v1' })
  return qc
}

const project = (qc: QueryClient) => qc.getQueryData<Project>(qk.project(7))
const live = () => useRealtime.getState().classMigration[7]
const start = (mergeIntoName: string | null, dialogOpen: boolean) =>
  useRealtime.getState().setClassMigrationStarted(7, { className: 'truck', mergeIntoName, dialogOpen })

describe('applyClassMigrationEvent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.error).mockClear()
    useRealtime.getState().reset()
  })
  afterEach(() => vi.useRealTimers())

  it('tracks progress in the store and in the cached project (detail and list)', () => {
    const qc = setup()
    applyClassMigrationEvent(qc, event())
    expect(live()).toMatchObject({ kind: 'delete', class_name: 'truck', done: 0, total: 0, finished: false })
    applyClassMigrationEvent(qc, event({ done: 3, total: 12 }))
    expect(live()).toMatchObject({ done: 3, total: 12, finished: false })
    expect(project(qc)?.class_migration).toEqual({ kind: 'delete', class_name: 'truck', done: 3, total: 12 })
    const list = qc.getQueryData<ProjectSummary[]>(qk.projects(false))
    expect(list?.map((p) => p.class_migration?.done ?? null)).toEqual([3, null])
    expect(qc.getQueryState(qk.annotation(7, 3))?.isInvalidated).toBe(false)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('on the final event clears the project flag, invalidates the label-dependent caches and later the store entry', () => {
    const qc = setup()
    applyClassMigrationEvent(qc, event({ done: 3, total: 12 }))
    applyClassMigrationEvent(qc, event({ done: 12, total: 12, finished: true, rewritten_files: 5 }))
    expect(project(qc)?.class_migration).toBeNull()
    expect(live()).toMatchObject({ finished: true, rewritten_files: 5 })
    expect(qc.getQueryState(qk.project(7))?.isInvalidated).toBe(true)
    expect(qc.getQueryState(qk.annotation(7, 3))?.isInvalidated).toBe(true)
    expect(qc.getQueryState(qk.annotation(8, 3))?.isInvalidated).toBe(false) // another project
    // Not started in this tab: no toast.
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    vi.advanceTimersByTime(CLASS_MIGRATION_LINGER_MS)
    expect(live()).toBeUndefined()
  })

  it('a migration that starts within the linger window keeps its own entry', () => {
    const qc = setup()
    applyClassMigrationEvent(qc, event({ finished: true, rewritten_files: 0 }))
    vi.advanceTimersByTime(1000)
    applyClassMigrationEvent(qc, event({ class_name: 'bus' }))
    vi.advanceTimersByTime(CLASS_MIGRATION_LINGER_MS)
    expect(live()).toMatchObject({ class_name: 'bus', finished: false })
  })

  it('toasts the result of a change started in this tab, once', () => {
    const qc = setup()
    start('car', false)
    applyClassMigrationEvent(qc, event({ kind: 'merge', finished: true, rewritten_files: 2 }))
    expect(toast.success).toHaveBeenCalledWith('Merged “truck” into “car”', { description: '2 label files rewritten.' })
    expect(useRealtime.getState().classMigrationStarted[7]).toBeUndefined()
    applyClassMigrationEvent(qc, event({ kind: 'merge', finished: true, rewritten_files: 2 }))
    expect(toast.success).toHaveBeenCalledTimes(1)

    start(null, false)
    applyClassMigrationEvent(qc, event({ finished: true, rewritten_files: 0 }))
    expect(toast.success).toHaveBeenLastCalledWith('Deleted class “truck”', { description: undefined })
  })

  it('toasts a failure, except an "in use" refusal while the dialog is open (shown there)', () => {
    const qc = setup()
    const failed = event({ finished: true, error: 'The class is still used in 3 images.', code: 'in_use', images: 3 })
    start(null, true)
    applyClassMigrationEvent(qc, failed)
    expect(toast.error).not.toHaveBeenCalled()
    expect(live()).toMatchObject({ finished: true, code: 'in_use', images: 3 })

    start(null, false)
    applyClassMigrationEvent(qc, failed)
    expect(toast.error).toHaveBeenCalledWith('Could not delete the class', { description: 'The class is still used in 3 images.' })

    start(null, true)
    applyClassMigrationEvent(qc, event({ finished: true, error: 'The server restarted.', code: 'interrupted' }))
    expect(toast.error).toHaveBeenLastCalledWith('Could not delete the class', { description: 'The server restarted.' })
    expect(toast.success).not.toHaveBeenCalled()
  })
})
