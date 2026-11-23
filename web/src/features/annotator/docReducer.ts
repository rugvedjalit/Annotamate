// Pure state machine for one image's annotation document: snapshot undo/redo, dirty tracking and the
// save state machine  saved → dirty → saving → saved | error | conflict.
import type { AnnotationDoc, UserBrief } from '@/lib/types'
import { fromApiBoxes, persistedKey, type EditorBox } from '@/lib/boxes'

export const MAX_HISTORY = 200

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict'
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface DocState {
  /** `${projectId}:${imageId}` of the document held in this state. */
  key: string | null
  status: LoadStatus
  loadError: unknown
  boxes: EditorBox[]
  /** What the server has (last load or successful save); dirty = boxes differ from this. */
  savedBoxes: EditorBox[]
  savedKey: string
  baseVersion: string | null
  past: EditorBox[][]
  future: EditorBox[][]
  dirty: boolean
  save: SaveState
  saveError: string | null
  /** Server document received with a 409 conflict. */
  conflict: AnnotationDoc | null
  readonlyReason: string | null
  /** Increments whenever the persisted content changes (drives autosave). */
  revision: number
  updatedAt: string | null
  updatedBy: UserBrief | null
}

export type DocAction =
  | { type: 'loadStart'; key: string }
  | { type: 'loadSuccess'; key: string; doc: AnnotationDoc }
  | { type: 'loadError'; key: string; error: unknown }
  | { type: 'restore'; state: DocState }
  | { type: 'commit'; boxes: EditorBox[] }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'saveStart' }
  | { type: 'saveSuccess'; sent: EditorBox[]; version: string; updatedAt: string | null; updatedBy: UserBrief | null }
  | { type: 'saveError'; message: string }
  | { type: 'saveConflict'; current: AnnotationDoc }
  | { type: 'resolveTheirs' }
  | { type: 'resolveMine' }
  | { type: 'readonly'; reason: string }
  /** The server copy changed while we had no local changes (another user saved): adopt it. */
  | { type: 'external'; doc: AnnotationDoc }
  /** The server wrote new content on our behalf (revision restore); kept as one undo step. */
  | { type: 'serverReplace'; boxes: EditorBox[]; version: string; updatedAt: string | null; updatedBy: UserBrief | null }

export const initialDocState: DocState = {
  key: null,
  status: 'idle',
  loadError: null,
  boxes: [],
  savedBoxes: [],
  savedKey: '',
  baseVersion: null,
  past: [],
  future: [],
  dirty: false,
  save: 'saved',
  saveError: null,
  conflict: null,
  readonlyReason: null,
  revision: 0,
  updatedAt: null,
  updatedBy: null,
}

function pushCapped(stack: EditorBox[][], item: EditorBox[]): EditorBox[][] {
  const next = stack.length >= MAX_HISTORY ? stack.slice(stack.length - MAX_HISTORY + 1) : stack.slice()
  next.push(item)
  return next
}

/** Recompute dirty/save after the current boxes changed. */
function withBoxes(state: DocState, boxes: EditorBox[], past: EditorBox[][], future: EditorBox[][]): DocState {
  const prevKey = persistedKey(state.boxes)
  const nextKey = persistedKey(boxes)
  const dirty = nextKey !== state.savedKey
  let save: SaveState = state.save
  if (save === 'saving' || save === 'conflict') {
    // keep: a save is in flight (its result decides) / the conflict dialog is open
  } else {
    save = dirty ? 'dirty' : 'saved'
  }
  return {
    ...state,
    boxes,
    past,
    future,
    dirty,
    save,
    saveError: save === 'dirty' || save === 'saved' ? null : state.saveError,
    revision: prevKey === nextKey ? state.revision : state.revision + 1,
  }
}

function loaded(key: string, doc: AnnotationDoc): DocState {
  const boxes = fromApiBoxes(doc.boxes)
  return {
    ...initialDocState,
    key,
    status: 'ready',
    boxes,
    savedBoxes: boxes,
    savedKey: persistedKey(boxes),
    baseVersion: doc.version,
    readonlyReason: doc.readonly_reason,
    updatedAt: doc.updated_at,
    updatedBy: doc.updated_by,
  }
}

export function docReducer(state: DocState, action: DocAction): DocState {
  switch (action.type) {
    case 'loadStart':
      return { ...initialDocState, key: action.key, status: 'loading' }

    case 'loadSuccess':
      if (state.key !== action.key) return state
      return loaded(action.key, action.doc)

    case 'loadError':
      if (state.key !== action.key || state.status === 'ready') return state
      return { ...state, status: 'error', loadError: action.error }

    case 'restore':
      return action.state

    case 'commit': {
      if (state.status !== 'ready' || action.boxes === state.boxes) return state
      return withBoxes(state, action.boxes, pushCapped(state.past, state.boxes), [])
    }

    case 'undo': {
      if (state.status !== 'ready' || state.past.length === 0) return state
      const past = state.past.slice(0, -1)
      const prev = state.past[state.past.length - 1]!
      return withBoxes(state, prev, past, pushCapped(state.future, state.boxes))
    }

    case 'redo': {
      if (state.status !== 'ready' || state.future.length === 0) return state
      const future = state.future.slice(0, -1)
      const next = state.future[state.future.length - 1]!
      return withBoxes(state, next, pushCapped(state.past, state.boxes), future)
    }

    case 'saveStart':
      if (state.status !== 'ready') return state
      return { ...state, save: 'saving', saveError: null }

    case 'saveSuccess': {
      if (state.status !== 'ready') return state
      const savedKey = persistedKey(action.sent)
      const dirty = persistedKey(state.boxes) !== savedKey
      return {
        ...state,
        savedBoxes: action.sent,
        savedKey,
        baseVersion: action.version,
        dirty,
        save: dirty ? 'dirty' : 'saved',
        saveError: null,
        updatedAt: action.updatedAt,
        updatedBy: action.updatedBy,
      }
    }

    case 'saveError':
      if (state.status !== 'ready') return state
      return { ...state, save: 'error', saveError: action.message }

    case 'saveConflict':
      if (state.status !== 'ready') return state
      return { ...state, save: 'conflict', conflict: action.current, saveError: null }

    case 'resolveTheirs': {
      if (!state.conflict) return state
      const theirs = fromApiBoxes(state.conflict.boxes)
      const savedKey = persistedKey(theirs)
      return {
        ...state,
        boxes: theirs,
        savedBoxes: theirs,
        savedKey,
        baseVersion: state.conflict.version,
        past: pushCapped(state.past, state.boxes),
        future: [],
        dirty: false,
        save: 'saved',
        saveError: null,
        conflict: null,
        readonlyReason: state.conflict.readonly_reason,
        revision: state.revision + 1,
        updatedAt: state.conflict.updated_at,
        updatedBy: state.conflict.updated_by,
      }
    }

    case 'resolveMine': {
      if (!state.conflict) return state
      const theirs = fromApiBoxes(state.conflict.boxes)
      const savedKey = persistedKey(theirs)
      const dirty = persistedKey(state.boxes) !== savedKey
      return {
        ...state,
        savedBoxes: theirs,
        savedKey,
        baseVersion: state.conflict.version,
        dirty,
        save: dirty ? 'dirty' : 'saved',
        conflict: null,
        saveError: null,
        revision: state.revision + 1,
        updatedAt: state.conflict.updated_at,
        updatedBy: state.conflict.updated_by,
      }
    }

    case 'readonly':
      return { ...state, readonlyReason: action.reason, save: state.dirty ? 'error' : state.save, saveError: state.dirty ? action.reason : state.saveError }

    case 'external': {
      if (state.status !== 'ready' || state.dirty || state.save === 'saving') return state
      const next = loaded(state.key ?? '', action.doc)
      return { ...next, revision: state.revision + 1 }
    }

    case 'serverReplace': {
      if (state.status !== 'ready') return state
      const savedKey = persistedKey(action.boxes)
      return {
        ...state,
        boxes: action.boxes,
        savedBoxes: action.boxes,
        savedKey,
        baseVersion: action.version,
        past: pushCapped(state.past, state.boxes),
        future: [],
        dirty: false,
        save: 'saved',
        saveError: null,
        revision: state.revision + 1,
        updatedAt: action.updatedAt,
        updatedBy: action.updatedBy,
      }
    }
  }
}
