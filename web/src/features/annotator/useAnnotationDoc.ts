// Owns one image's annotation document: load (with prefetch cache), snapshot undo/redo, the save state machine
// with debounced autosave, awaited flush before navigation, conflict handling and per-image history (20 images).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getAnnotation, restoreRevision as restoreRevisionApi, saveAnnotation } from '@/lib/endpoints'
import { ApiError, errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import { fromApiBox, toApiBoxes, type EditorBox } from '@/lib/boxes'
import { upsertImageItem } from '@/lib/cacheUpdates'
import type { AnnotationDoc, UserBrief } from '@/lib/types'
import { realtime } from '@/stores/realtime'
import { useSession } from '@/stores/session'
import { docReducer, initialDocState, type DocAction, type DocState } from './docReducer'
import { docHistoryCache } from './historyCache'

export interface DocOptions {
  /** The user may save right now (edit permission, lock held, not read-only). */
  canSave: boolean
  /** `force: true` is accepted by the server (reviewer+ or lock holder). */
  forceAllowed: boolean
  autosave: boolean
  autosaveDelayMs: number
  /** A save was refused because someone else holds the edit lock. */
  onLocked?: (holder: UserBrief | null) => void
}

export interface AnnotationDocApi {
  state: DocState
  /** True when the loaded document belongs to the requested image. */
  ready: boolean
  boxes: EditorBox[]
  canUndo: boolean
  canRedo: boolean
  commit: (boxes: EditorBox[]) => void
  undo: () => void
  redo: () => void
  /** Save now. Resolves true when everything is saved. */
  save: (opts?: { force?: boolean }) => Promise<boolean>
  /** Await any pending/in-flight save; false means unsaved work remains (navigation must be cancelled). */
  flush: () => Promise<boolean>
  resolveTheirs: () => void
  keepMine: () => Promise<boolean>
  restoreRevision: (revisionId: number, boxes: EditorBox[]) => Promise<boolean>
  reload: () => void
}

const FRESH_PREFETCH_MS = 20_000
const RETRY_DELAYS_MS = [2000, 5000, 15000]

export function useAnnotationDoc(projectId: number, imageId: number, options: DocOptions): AnnotationDocApi {
  const qc = useQueryClient()
  const key = `${projectId}:${imageId}`
  const [state, setState] = useState<DocState>(initialDocState)
  const stateRef = useRef<DocState>(initialDocState)
  const optsRef = useRef(options)
  const inflight = useRef<Promise<boolean> | null>(null)
  const retryAttempt = useRef(0)
  const [loadNonce, setLoadNonce] = useState(0)
  const skipStash = useRef(false)
  /** The document this hook instance currently displays (null once it unmounted or moved on). */
  const activeKey = useRef<string | null>(null)

  useEffect(() => {
    optsRef.current = options
  })

  const apply = useCallback((action: DocAction) => {
    const next = docReducer(stateRef.current, action)
    if (next === stateRef.current) return
    stateRef.current = next
    setState(next)
  }, [])

  /**
   * Apply to the live state if this instance still displays the document, else to its cached copy. An
   * unmounted workspace keeps its last state in the cache, so a save that finishes later still lands there.
   */
  const applyFor = useCallback(
    (docKey: string, action: DocAction) => {
      if (activeKey.current === docKey && stateRef.current.key === docKey) apply(action)
      else docHistoryCache.update(docKey, (s) => docReducer(s, action))
    },
    [apply],
  )

  // ------------------------------------------------------------------ load / restore
  useEffect(() => {
    activeKey.current = key
    const cached = docHistoryCache.get(key)
    if (cached && cached.status === 'ready') {
      apply({ type: 'restore', state: cached })
    } else {
      apply({ type: 'loadStart', key })
      const prefetched = qc.getQueryState<AnnotationDoc>(qk.annotation(projectId, imageId))
      if (prefetched?.data && !prefetched.isInvalidated && Date.now() - prefetched.dataUpdatedAt < FRESH_PREFETCH_MS) {
        apply({ type: 'loadSuccess', key, doc: prefetched.data })
      }
    }

    let cancelled = false
    qc.fetchQuery({
      queryKey: qk.annotation(projectId, imageId),
      queryFn: ({ signal }) => getAnnotation(projectId, imageId, { signal }),
      staleTime: 0,
    })
      .then((doc) => {
        if (cancelled || stateRef.current.key !== key) return
        const s = stateRef.current
        if (s.status !== 'ready') {
          apply({ type: 'loadSuccess', key, doc })
        } else if (doc.version !== s.baseVersion) {
          // Changed on the server since we cached/prefetched it. Without local edits, adopt it;
          // with local edits, the next save reports a conflict (never silently overwritten).
          if (!s.dirty && s.save !== 'saving') apply({ type: 'external', doc })
        } else if (doc.readonly_reason && doc.readonly_reason !== s.readonlyReason) {
          apply({ type: 'readonly', reason: doc.readonly_reason })
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) apply({ type: 'loadError', key, error })
      })

    return () => {
      cancelled = true
      activeKey.current = null
      const s = stateRef.current
      if (!skipStash.current && s.key === key && s.status === 'ready') docHistoryCache.put(key, s)
      skipStash.current = false
    }
  }, [key, projectId, imageId, qc, apply, loadNonce])

  // ------------------------------------------------------------------ save
  const saveOnce = useCallback(
    async (force: boolean): Promise<boolean> => {
      const s = stateRef.current
      if (s.status !== 'ready' || s.key !== key) return true
      if (s.save === 'conflict') return false
      if (!s.dirty && !force) return true
      if (!optsRef.current.canSave || s.readonlyReason) return false
      const docKey = key
      const sent = s.boxes
      apply({ type: 'saveStart' })
      try {
        const res = await saveAnnotation(projectId, imageId, {
          base_version: s.baseVersion,
          boxes: toApiBoxes(sent),
          ...(force ? { force: true } : {}),
        })
        const me = useSession.getState().user
        const updatedBy = me
          ? { id: me.id, username: me.username, display_name: me.display_name, avatar_color: me.avatar_color }
          : null
        applyFor(docKey, { type: 'saveSuccess', sent, version: res.version, updatedAt: res.updated_at, updatedBy })
        retryAttempt.current = 0
        upsertImageItem(qc, projectId, res.image)
        // The cache mirrors the server: its normalised boxes (what a reload returns). The editor keeps the
        // boxes it sent (they only differ by rounding), so the document does not turn dirty again.
        qc.setQueryData<AnnotationDoc>(qk.annotation(projectId, imageId), {
          version: res.version,
          boxes: res.boxes ?? toApiBoxes(sent),
          readonly_reason: null,
          updated_at: res.updated_at,
          updated_by: updatedBy,
        })
        void qc.invalidateQueries({ queryKey: qk.revisions(projectId, imageId) })
        return true
      } catch (err) {
        if (err instanceof ApiError && err.code === 'conflict' && err.extra.current) {
          applyFor(docKey, { type: 'saveConflict', current: err.extra.current as AnnotationDoc })
        } else if (err instanceof ApiError && err.code === 'readonly') {
          applyFor(docKey, { type: 'readonly', reason: err.detail })
        } else if (err instanceof ApiError && err.code === 'migrating') {
          // A class delete/merge is rewriting label files. The boxes stay in memory (dirty); the project is
          // refetched so the workspace turns read-only, and saving resumes when the migration ends.
          applyFor(docKey, { type: 'saveError', message: err.detail })
          retryAttempt.current = 0
          toast.error('Saving is paused', { id: `class-migration-save:${projectId}`, description: err.detail })
          void qc.invalidateQueries({ queryKey: qk.project(projectId) })
        } else if (err instanceof ApiError && err.status === 423) {
          applyFor(docKey, { type: 'saveError', message: err.detail })
          optsRef.current.onLocked?.((err.extra.holder as UserBrief | undefined) ?? null)
        } else {
          applyFor(docKey, { type: 'saveError', message: errorMessage(err) })
        }
        return false
      }
    },
    [key, projectId, imageId, qc, apply, applyFor],
  )

  const save = useCallback(
    async (opts?: { force?: boolean }): Promise<boolean> => {
      // One save at a time: wait for the in-flight one, then save whatever changed meanwhile.
      while (inflight.current) await inflight.current
      const p = saveOnce(!!opts?.force)
      inflight.current = p
      try {
        return await p
      } finally {
        inflight.current = null
      }
    },
    [saveOnce],
  )

  const flush = useCallback(async (): Promise<boolean> => {
    for (let i = 0; i < 4; i++) {
      while (inflight.current) await inflight.current
      const s = stateRef.current
      if (s.key !== key || s.status !== 'ready' || !s.dirty) return true
      if (s.save === 'conflict') return false
      // Read-only (lock lost / revoked): nothing can be saved. The edits stay in this tab's history
      // cache for this image, so leaving is allowed.
      if (!optsRef.current.canSave || s.readonlyReason) return true
      if (!(await save())) return false
    }
    return !stateRef.current.dirty
  }, [key, save])

  // Debounced autosave after the last change.
  useEffect(() => {
    if (!options.autosave || !options.canSave) return
    if (state.status !== 'ready' || state.key !== key || state.save !== 'dirty') return
    const t = setTimeout(() => void save(), options.autosaveDelayMs)
    return () => clearTimeout(t)
  }, [state.revision, state.save, state.status, state.key, key, options.autosave, options.canSave, options.autosaveDelayMs, save])

  // Automatic retry with backoff for network/server errors (autosave mode).
  useEffect(() => {
    if (!options.autosave || !options.canSave || state.save !== 'error' || state.key !== key || state.readonlyReason) return
    const attempt = retryAttempt.current
    if (attempt >= RETRY_DELAYS_MS.length) return
    const t = setTimeout(() => {
      retryAttempt.current = attempt + 1
      void save()
    }, RETRY_DELAYS_MS[attempt])
    return () => clearTimeout(t)
  }, [state.save, state.key, state.saveError, state.readonlyReason, key, options.autosave, options.canSave, save])

  // Warn before closing the tab only while there is unsaved work.
  const unsaved = state.key === key && (state.dirty || state.save === 'saving')
  useEffect(() => {
    if (!unsaved) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [unsaved])

  // Someone else saved this image (or we reconnected after missing events): adopt their version when we
  // have no local changes; otherwise the next save surfaces the conflict.
  useEffect(() => {
    const refreshIfChanged = (version?: string) => {
      const s = stateRef.current
      if (s.key !== key || s.status !== 'ready' || s.dirty || s.save === 'saving') return
      if (version !== undefined && version === s.baseVersion) return
      getAnnotation(projectId, imageId)
        .then((doc) => {
          const cur = stateRef.current
          if (cur.key === key && doc.version !== cur.baseVersion) apply({ type: 'external', doc })
        })
        .catch(() => undefined)
    }
    const offUpdate = realtime.on('image.updated', (m) => {
      if (m.project_id !== projectId || m.image.id !== imageId || !m.version) return
      if (m.by && m.by.id === useSession.getState().user?.id) return
      refreshIfChanged(m.version)
    })
    // A class delete/merge rewrote label files: reload this one if it changed.
    const offMigration = realtime.on('classes.migration', (m) => {
      if (m.project_id === projectId && m.finished) refreshIfChanged()
    })
    const offOpen = realtime.onOpen(({ reconnected }) => {
      if (reconnected) refreshIfChanged()
    })
    return () => {
      offUpdate()
      offMigration()
      offOpen()
    }
  }, [key, projectId, imageId, apply])

  const commit = useCallback((boxes: EditorBox[]) => apply({ type: 'commit', boxes }), [apply])
  const undo = useCallback(() => apply({ type: 'undo' }), [apply])
  const redo = useCallback(() => apply({ type: 'redo' }), [apply])
  const resolveTheirs = useCallback(() => apply({ type: 'resolveTheirs' }), [apply])
  const keepMine = useCallback(async () => {
    apply({ type: 'resolveMine' })
    return save({ force: optsRef.current.forceAllowed })
  }, [apply, save])

  const restoreRevision = useCallback(
    async (revisionId: number, boxes: EditorBox[]) => {
      if (!(await flush())) return false
      const s = stateRef.current
      if (s.key !== key || s.status !== 'ready') return false
      const res = await restoreRevisionApi(projectId, imageId, revisionId, s.baseVersion)
      // Adopt what was actually written (the revision's boxes, normalised by the server).
      const restored = res.boxes ? res.boxes.map(fromApiBox) : boxes
      apply({ type: 'serverReplace', boxes: restored, version: res.version, updatedAt: res.updated_at, updatedBy: useSession.getState().user })
      upsertImageItem(qc, projectId, res.image)
      void qc.invalidateQueries({ queryKey: qk.revisions(projectId, imageId) })
      return true
    },
    [flush, key, projectId, imageId, apply, qc],
  )

  const reload = useCallback(() => {
    docHistoryCache.delete(key)
    skipStash.current = true
    setLoadNonce((n) => n + 1)
  }, [key])

  const ready = state.key === key && state.status === 'ready'
  return {
    state,
    ready,
    boxes: ready ? state.boxes : EMPTY,
    canUndo: ready && state.past.length > 0,
    canRedo: ready && state.future.length > 0,
    commit,
    undo,
    redo,
    save,
    flush,
    resolveTheirs,
    keepMine,
    restoreRevision,
    reload,
  }
}

const EMPTY: EditorBox[] = []
