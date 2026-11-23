import { createContext, useContext } from 'react'
import type { Project } from '@/lib/types'

export interface ProjectContextValue {
  projectId: number
  project: Project
}

export const ProjectContext = createContext<ProjectContextValue | null>(null)

/** The project of the current /p/:projectId route (loaded by ProjectLayout). */
export function useProjectContext(): ProjectContextValue {
  const ctx = useContext(ProjectContext)
  if (!ctx) throw new Error('useProjectContext() must be used inside ProjectLayout')
  return ctx
}

export function useOptionalProjectContext(): ProjectContextValue | null {
  return useContext(ProjectContext)
}
