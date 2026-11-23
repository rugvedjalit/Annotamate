// Box editing commands shared by the keyboard, the floating toolbar, the context menu and the inspector.
// Every command that changes boxes is one undo step (one doc.commit).
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { clampBox, translateBoxes } from '@/canvas'
import { cloneBoxes, fromApiBoxes, isValidBox, type EditorBox } from '@/lib/boxes'
import { createClass as createClassApi, getAnnotation } from '@/lib/endpoints'
import { ApiError, errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import { nextClassColor } from '@/lib/colors'
import { setProjectClasses } from '@/lib/cacheUpdates'
import type { ImageDetail, ProjectClass } from '@/lib/types'
import type { AnnotationDocApi } from './useAnnotationDoc'
import { docHistoryCache } from './historyCache'
import { getLastVisited } from './lastVisited'
import { useAnnotator } from './store'

export interface BoxActions {
  assignClass: (ids: string[], classId: number) => void
  /** 1–9: assign to the selection, or set the active class when nothing is selected. */
  classShortcut: (n: number) => void
  cycleClass: (delta: 1 | -1) => void
  remove: (ids: string[]) => void
  duplicate: (ids: string[]) => void
  copy: (ids: string[]) => void
  paste: () => void
  pastePrevious: () => Promise<void>
  nudge: (dx: number, dy: number) => void
  toggleLocked: (ids: string[]) => void
  toggleHidden: (ids: string[]) => void
  setAllHidden: (hidden: boolean) => void
  updateBox: (id: string, patch: Partial<EditorBox>) => void
  /** Set VOC flags on several boxes in one undo step. */
  patchFlags: (ids: string[], patch: Pick<EditorBox, 'difficult' | 'truncated'>) => void
  selectAll: () => void
  cycleSelection: () => void
  createClass: (name: string) => Promise<ProjectClass | null>
  /** Assign a project class to every box with this unknown raw label. */
  mapUnknownLabel: (rawLabel: string, classId: number) => void
}

interface Deps {
  projectId: number
  imageId: number
  image: ImageDetail | undefined
  doc: AnnotationDocApi
  editable: boolean
  classes: ProjectClass[]
  /** Previous image in the current order (fallback for "paste previous" when nothing was visited). */
  prevId: number | null
  revealBox: (id: string) => void
}

const selected = () => useAnnotator.getState().selectedIds

export function useBoxActions(d: Deps): BoxActions {
  const qc = useQueryClient()
  const w = d.image?.width ?? 0
  const h = d.image?.height ?? 0

  const commitIfChanged = (next: EditorBox[]) => {
    if (next !== d.doc.boxes) d.doc.commit(next)
  }

  const mapSelected = (ids: string[], fn: (b: EditorBox) => EditorBox) => {
    const set = new Set(ids)
    let changed = false
    const next = d.doc.boxes.map((b) => {
      if (!set.has(b.id)) return b
      const n = fn(b)
      if (n !== b) changed = true
      return n
    })
    if (changed) commitIfChanged(next)
  }

  const assignClass = (ids: string[], classId: number) => {
    if (!d.editable || ids.length === 0) return
    mapSelected(ids, (b) => (b.classId === classId ? b : { ...b, classId, rawLabel: null }))
  }

  const insert = (boxes: EditorBox[], what: string) => {
    const valid = boxes.filter(isValidBox)
    if (valid.length === 0) return
    d.doc.commit([...d.doc.boxes, ...valid])
    useAnnotator.getState().select(valid.map((b) => b.id))
    toast.success(`${what} ${valid.length} box${valid.length === 1 ? '' : 'es'}`, { duration: 1800 })
  }

  async function loadPreviousBoxes(): Promise<EditorBox[] | null> {
    const prevId = getLastVisited(d.projectId, d.imageId) ?? d.prevId
    if (prevId === null) return null
    const cached = docHistoryCache.get(`${d.projectId}:${prevId}`)
    if (cached?.status === 'ready') return cached.boxes
    const doc = await qc.fetchQuery({
      queryKey: qk.annotation(d.projectId, prevId),
      queryFn: ({ signal }) => getAnnotation(d.projectId, prevId, { signal }),
      staleTime: 10_000,
    })
    return fromApiBoxes(doc.boxes)
  }

  return {
    assignClass,

    classShortcut: (n) => {
      const cls = d.classes[n - 1]
      if (!cls) return
      useAnnotator.getState().setActiveClassId(cls.id)
      assignClass(selected(), cls.id)
    },

    cycleClass: (delta) => {
      if (d.classes.length === 0) return
      const st = useAnnotator.getState()
      const i = d.classes.findIndex((c) => c.id === st.activeClassId)
      const next = d.classes[(i + delta + d.classes.length) % d.classes.length]!
      st.setActiveClassId(next.id)
      assignClass(st.selectedIds, next.id)
    },

    remove: (ids) => {
      if (!d.editable || ids.length === 0) return
      const set = new Set(ids)
      const locked = d.doc.boxes.filter((b) => set.has(b.id) && b.locked).length
      const next = d.doc.boxes.filter((b) => !set.has(b.id) || b.locked)
      if (next.length !== d.doc.boxes.length) d.doc.commit(next)
      useAnnotator.getState().select(ids.filter((id) => next.some((b) => b.id === id)))
      if (locked) toast.info(`${locked} locked box${locked === 1 ? ' was' : 'es were'} kept. Unlock to delete.`)
    },

    duplicate: (ids) => {
      if (!d.editable || !w || !h) return
      const set = new Set(ids)
      insert(cloneBoxes(d.doc.boxes.filter((b) => set.has(b.id)), w, h, 10), 'Duplicated')
    },

    copy: (ids) => {
      const set = new Set(ids)
      const boxes = d.doc.boxes.filter((b) => set.has(b.id))
      if (boxes.length === 0) return
      useAnnotator.getState().setClipboard(boxes)
      toast(`Copied ${boxes.length} box${boxes.length === 1 ? '' : 'es'}`, { duration: 1500 })
    },

    paste: () => {
      const clip = useAnnotator.getState().clipboard
      if (!d.editable || !clip?.length || !w || !h) return
      const overlaps = clip.some((c) => d.doc.boxes.some((b) => b.x1 === c.x1 && b.y1 === c.y1 && b.x2 === c.x2 && b.y2 === c.y2))
      insert(cloneBoxes(clip, w, h, overlaps ? 10 : 0), 'Pasted')
    },

    pastePrevious: async () => {
      if (!d.editable || !w || !h) return
      try {
        const boxes = await loadPreviousBoxes()
        if (!boxes) {
          toast.info('There is no previous image to copy from.')
          return
        }
        if (boxes.length === 0) {
          toast.info('The previous image has no boxes.')
          return
        }
        insert(cloneBoxes(boxes, w, h, 0), 'Pasted')
      } catch (err) {
        toast.error('Could not load the previous image’s boxes', { description: errorMessage(err) })
      }
    },

    nudge: (dx, dy) => {
      if (!d.editable || !w || !h) return
      const set = new Set(selected())
      const movable = d.doc.boxes.filter((b) => set.has(b.id) && !b.locked)
      if (movable.length === 0) return
      const moved = translateBoxes(movable, dx, dy, w, h)
      const byId = new Map(moved.map((b) => [b.id, b]))
      d.doc.commit(d.doc.boxes.map((b) => byId.get(b.id) ?? b))
    },

    toggleLocked: (ids) => {
      if (ids.length === 0) return
      const set = new Set(ids)
      const anyUnlocked = d.doc.boxes.some((b) => set.has(b.id) && !b.locked)
      mapSelected(ids, (b) => ({ ...b, locked: anyUnlocked }))
    },

    toggleHidden: (ids) => {
      if (ids.length === 0) return
      const set = new Set(ids)
      const anyVisible = d.doc.boxes.some((b) => set.has(b.id) && !b.hidden)
      mapSelected(ids, (b) => ({ ...b, hidden: anyVisible }))
    },

    setAllHidden: (hidden) => {
      if (d.doc.boxes.every((b) => !!b.hidden === hidden)) return
      d.doc.commit(d.doc.boxes.map((b) => (!!b.hidden === hidden ? b : { ...b, hidden })))
    },

    updateBox: (id, patch) => {
      if (!d.editable) return
      mapSelected([id], (b) => {
        let n: EditorBox = { ...b, ...patch }
        if (w && h) n = clampBox(n, w, h)
        if (!isValidBox(n)) return b
        const same =
          n.x1 === b.x1 && n.y1 === b.y1 && n.x2 === b.x2 && n.y2 === b.y2 &&
          n.classId === b.classId && !!n.difficult === !!b.difficult && !!n.truncated === !!b.truncated
        return same ? b : n
      })
    },

    patchFlags: (ids, patch) => {
      if (!d.editable) return
      mapSelected(ids, (b) =>
        (patch.difficult === undefined || !!b.difficult === patch.difficult) &&
        (patch.truncated === undefined || !!b.truncated === patch.truncated)
          ? b
          : { ...b, ...patch },
      )
    },

    selectAll: () => {
      useAnnotator.getState().select(d.doc.boxes.filter((b) => !b.hidden).map((b) => b.id))
    },

    cycleSelection: () => {
      const visible = d.doc.boxes.filter((b) => !b.hidden)
      if (visible.length === 0) return
      const cur = selected()
      const last = cur[cur.length - 1]
      const i = visible.findIndex((b) => b.id === last)
      const next = visible[(i + 1) % visible.length]!
      useAnnotator.getState().select([next.id])
      d.revealBox(next.id)
    },

    createClass: async (name) => {
      const trimmed = name.trim()
      if (!trimmed) return null
      try {
        const created = await createClassApi(d.projectId, { name: trimmed, color: nextClassColor(d.classes.map((c) => c.color)) })
        setProjectClasses(qc, d.projectId, [...d.classes.filter((c) => c.id !== created.id), created])
        toast.success(`Class “${created.name}” created`)
        return created
      } catch (err) {
        if (err instanceof ApiError && err.code === 'exists') {
          const existing = d.classes.find((c) => c.name.toLowerCase() === trimmed.toLowerCase())
          if (existing) return existing
        }
        toast.error('Could not create the class', { description: errorMessage(err) })
        return null
      }
    },

    mapUnknownLabel: (rawLabel, classId) => {
      if (!d.editable) return
      const ids = d.doc.boxes.filter((b) => b.classId === null && b.rawLabel === rawLabel).map((b) => b.id)
      assignClass(ids, classId)
    },
  }
}
