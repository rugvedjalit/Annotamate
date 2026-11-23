import { useId, useState } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { deleteProject } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import type { Project } from '@/lib/types'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { SettingsCard } from './SettingsCard'
import { useUpdateProject } from './settingsHooks'

export function DangerZoneTab({ project }: { project: Project }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const update = useUpdateProject(project.id)
  const confirmId = useId()
  const [confirmArchive, setConfirmArchive] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [typed, setTyped] = useState('')

  async function remove() {
    try {
      await deleteProject(project.id)
    } catch (err) {
      toast.error('Could not delete the project', { description: errorMessage(err) })
      throw err
    }
    navigate('/', { replace: true })
    qc.removeQueries({ queryKey: qk.project(project.id) })
    void qc.invalidateQueries({ queryKey: qk.projectsAll })
    toast.success(`Deleted “${project.name}”`, { description: 'Images and label files on disk were not touched.' })
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsCard
        title={project.archived ? 'Restore project' : 'Archive project'}
        description={
          project.archived
            ? 'Bring the project back to the projects page. Nothing was changed while it was archived.'
            : 'Hide the project from the projects page. Members keep access through “Show archived”; nothing is deleted.'
        }
        footer={
          project.archived ? (
            <Button
              variant="secondary"
              loading={update.isPending}
              onClick={() => update.mutate({ archived: false }, { onSuccess: () => toast.success('Project restored') })}
            >
              {!update.isPending && <ArchiveRestore />}
              Restore project
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setConfirmArchive(true)}>
              <Archive />
              Archive project
            </Button>
          )
        }
      >
        <p className="text-sm text-muted">
          Archived projects stay fully readable; you can restore them at any time.
        </p>
      </SettingsCard>

      {project.permissions.can_delete && (
        <SettingsCard
          tone="danger"
          title="Delete project"
          description="Removes the project, its members, chat, comments, activity and revision history from Annotamate."
          footer={
            <Button variant="danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 />
              Delete project
            </Button>
          }
        >
          <p className="text-sm text-muted">
            Images and label files on disk are <span className="font-medium text-fg">not</span> deleted. You can create a
            new project for the same folder later.
          </p>
        </SettingsCard>
      )}

      <ConfirmDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title="Archive this project?"
        description="It disappears from the projects page for everyone. You can restore it from this page."
        confirmLabel="Archive"
        onConfirm={() =>
          update.mutateAsync({ archived: true }).then(() => toast.success('Project archived'))
        }
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={(o) => {
          setConfirmDelete(o)
          if (!o) setTyped('')
        }}
        danger
        title={`Delete “${project.name}”?`}
        description="This cannot be undone. Files on disk stay where they are."
        confirmLabel="Delete project"
        confirmDisabled={typed.trim() !== project.name}
        onConfirm={remove}
      >
        <label htmlFor={confirmId} className="mb-1.5 block text-sm text-muted">
          Type <span className="font-mono font-medium text-fg">{project.name}</span> to confirm.
        </label>
        <Input id={confirmId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      </ConfirmDialog>
    </div>
  )
}
