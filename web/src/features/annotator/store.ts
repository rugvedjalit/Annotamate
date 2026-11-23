// Workspace UI state (tool, selection, picker, pins, preview, view). Document data lives in useAnnotationDoc.
import { create } from 'zustand'
import type { CanvasTool, ViewState } from '@/canvas'
import type { EditorBox } from '@/lib/boxes'

export type InspectorTab = 'labels' | 'comments' | 'history' | 'info'

export type PickerState =
  | { mode: 'new'; box: EditorBox; anchor: { x: number; y: number } }
  | { mode: 'assign'; ids: string[]; anchor: { x: number; y: number } }

export interface RevisionPreview {
  revisionId: number
  boxes: EditorBox[]
  label: string
}

export interface ContextMenuState {
  clientX: number
  clientY: number
  boxId: string | null
}

interface AnnotatorState {
  tool: CanvasTool
  /** Space held: temporary pan tool. */
  spacePan: boolean
  selectedIds: string[]
  hoverId: string | null
  activeClassId: number | null
  picker: PickerState | null
  placingPin: boolean
  pendingPin: { x: number; y: number } | null
  showPins: boolean
  inspectorTab: InspectorTab
  focusCommentId: number | null
  preview: RevisionPreview | null
  contextMenu: ContextMenuState | null
  cursor: { x: number; y: number } | null
  view: ViewState | null
  /** Pointer is down on the canvas (hide floating UI during gestures). */
  gesture: boolean
  /** Boxes copied with Mod+C (kept across images). */
  clipboard: EditorBox[] | null

  setTool: (tool: CanvasTool) => void
  setSpacePan: (on: boolean) => void
  select: (ids: string[]) => void
  setHoverId: (id: string | null) => void
  setActiveClassId: (id: number | null) => void
  openPicker: (p: PickerState) => void
  closePicker: () => void
  setPlacingPin: (on: boolean) => void
  setPendingPin: (p: { x: number; y: number } | null) => void
  setShowPins: (on: boolean) => void
  setInspectorTab: (tab: InspectorTab) => void
  focusComment: (id: number | null) => void
  setPreview: (p: RevisionPreview | null) => void
  setContextMenu: (m: ContextMenuState | null) => void
  setCursor: (p: { x: number; y: number } | null) => void
  setView: (v: ViewState) => void
  setGesture: (on: boolean) => void
  setClipboard: (boxes: EditorBox[] | null) => void
  /** Per-image transient state (on image change). */
  resetForImage: () => void
  /** Per-project state (on project change). */
  resetForProject: () => void
}

export const useAnnotator = create<AnnotatorState>()((set) => ({
  tool: 'box',
  spacePan: false,
  selectedIds: [],
  hoverId: null,
  activeClassId: null,
  picker: null,
  placingPin: false,
  pendingPin: null,
  showPins: true,
  inspectorTab: 'labels',
  focusCommentId: null,
  preview: null,
  contextMenu: null,
  cursor: null,
  view: null,
  gesture: false,
  clipboard: null,

  setTool: (tool) => set({ tool, placingPin: false }),
  setSpacePan: (spacePan) => set({ spacePan }),
  select: (selectedIds) => set({ selectedIds }),
  setHoverId: (hoverId) => set({ hoverId }),
  setActiveClassId: (activeClassId) => set({ activeClassId }),
  openPicker: (picker) => set({ picker, contextMenu: null }),
  closePicker: () => set({ picker: null }),
  setPlacingPin: (placingPin) => set({ placingPin }),
  setPendingPin: (pendingPin) => set({ pendingPin }),
  setShowPins: (showPins) => set({ showPins }),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  focusComment: (focusCommentId) => set(focusCommentId === null ? { focusCommentId } : { focusCommentId, inspectorTab: 'comments' }),
  setPreview: (preview) => set({ preview, selectedIds: [], picker: null }),
  setContextMenu: (contextMenu) => set({ contextMenu }),
  setCursor: (cursor) => set({ cursor }),
  setView: (view) => set({ view }),
  setGesture: (gesture) => set({ gesture }),
  setClipboard: (clipboard) => set({ clipboard }),
  resetForImage: () =>
    set({
      selectedIds: [],
      hoverId: null,
      picker: null,
      placingPin: false,
      pendingPin: null,
      focusCommentId: null,
      preview: null,
      contextMenu: null,
      cursor: null,
      gesture: false,
    }),
  resetForProject: () => set({ activeClassId: null, selectedIds: [], picker: null, preview: null, contextMenu: null }),
}))
