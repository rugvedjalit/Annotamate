import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { updateProject } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import type { Project, UpdateProjectBody } from '@/lib/types'

function applyPatch(p: Project, body: UpdateProjectBody): Project {
  const { settings, ...rest } = body
  return { ...p, ...rest, settings: settings ? { ...p.settings, ...settings } : p.settings }
}

/** PATCH the project with an optimistic cache update (rolled back on error). */
export function useUpdateProject(projectId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: UpdateProjectBody) => updateProject(projectId, body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: qk.project(projectId), exact: true })
      const prev = qc.getQueryData<Project>(qk.project(projectId))
      if (prev) qc.setQueryData<Project>(qk.project(projectId), applyPatch(prev, body))
      return { prev }
    },
    onError: (err, _body, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.project(projectId), ctx.prev)
      toast.error('Could not save the project', { description: errorMessage(err) })
    },
    onSuccess: (project) => {
      qc.setQueryData(qk.project(projectId), project)
      void qc.invalidateQueries({ queryKey: qk.projectsAll })
    },
  })
}
