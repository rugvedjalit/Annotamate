import { createContext, useContext, type RefObject } from 'react'
import type { AnnotationCanvasHandle } from '@/canvas'
import type { ImageFilters } from '@/lib/filters'
import type { ImageDetail, Neighbors, Project, ProjectClass, StatusAction, UserBrief } from '@/lib/types'
import type { AnnotationDocApi } from './useAnnotationDoc'
import type { ImageLock } from './useImageLock'
import type { BoxActions } from './useBoxActions'

export type ReadOnlyKind =
  | 'permission' // viewer role
  | 'locked' // someone else holds the edit lock
  | 'revoked' // someone took over from us
  | 'acquiring' // waiting for the lock
  | 'assigned' // restrict_to_assigned and assigned to someone else
  | 'migrating' // a class delete/merge is rewriting label files (saving is paused)
  | 'file' // label file cannot be edited safely (readonly_reason)
  | 'image' // image cannot be decoded
  | 'device' // small/touch screens are view-only
  | 'preview' // previewing a revision

export interface ReadOnlyInfo {
  kind: ReadOnlyKind
  message: string
  holder?: UserBrief | null
}

export interface Navigation {
  prevId: number | null
  nextId: number | null
  /** 0-based index within the current filter (-1 when the image is not in it). */
  index: number
  total: number | null
  goTo: (imageId: number) => Promise<boolean>
  goPrev: () => void
  goNext: () => void
}

export interface Workspace {
  projectId: number
  project: Project
  imageId: number
  image: ImageDetail | undefined
  filters: ImageFilters
  neighbors: Neighbors | undefined
  doc: AnnotationDocApi
  lock: ImageLock
  /** Edits are possible right now. */
  editable: boolean
  readOnly: ReadOnlyInfo | null
  canvasRef: RefObject<AnnotationCanvasHandle | null>
  classes: ProjectClass[]
  classById: ReadonlyMap<number, ProjectClass>
  actions: BoxActions
  nav: Navigation
  changeStatus: (action: StatusAction, comment?: string) => Promise<boolean>
  toggleFlag: () => void
}

export const WorkspaceContext = createContext<Workspace | null>(null)

export function useWorkspace(): Workspace {
  const ws = useContext(WorkspaceContext)
  if (!ws) throw new Error('useWorkspace() must be used inside the annotator workspace')
  return ws
}
