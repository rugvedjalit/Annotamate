import { useId, useState, type FormEvent } from 'react'
import { useMutation } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { rescanProject } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { formatDateTime, formatNumber } from '@/lib/format'
import { FORMAT_DESCRIPTIONS } from '@/lib/status'
import type { Project } from '@/lib/types'
import { useRealtime } from '@/stores/realtime'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input, Textarea } from '@/components/ui/Input'
import { FormatBadge } from '@/components/ui/Badge'
import { Spinner } from '@/components/ui/Feedback'
import { InfoRow, SettingsCard } from './SettingsCard'
import { useUpdateProject } from './settingsHooks'

export function GeneralTab({ project }: { project: Project }) {
  const ids = { name: useId(), desc: useId() }
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description)
  const update = useUpdateProject(project.id)
  const indexing = useRealtime((s) => s.indexing[project.id])
  const isIndexing = indexing ? !indexing.finished : project.indexing
  const dirty = name.trim() !== project.name || description.trim() !== project.description
  const nameError = !name.trim() ? 'The project needs a name.' : null

  const rescan = useMutation({
    mutationFn: () => rescanProject(project.id),
    onSuccess: () => toast.success('Rescan started', { description: 'Progress is shown on the overview page.' }),
    onError: (err) => toast.error('Could not start the rescan', { description: errorMessage(err) }),
  })

  function save(e: FormEvent) {
    e.preventDefault()
    if (nameError || !dirty) return
    update.mutate(
      { name: name.trim(), description: description.trim() },
      { onSuccess: () => toast.success('Project details saved') },
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={save}>
        <SettingsCard
          title="Details"
          description="Shown on the projects page and to every member."
          footer={
            <>
              <Button
                variant="ghost"
                disabled={!dirty || update.isPending}
                onClick={() => {
                  setName(project.name)
                  setDescription(project.description)
                }}
              >
                Reset
              </Button>
              <Button type="submit" variant="primary" disabled={!dirty || !!nameError} loading={update.isPending}>
                Save changes
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <Field label="Name" htmlFor={ids.name} error={nameError}>
              <Input id={ids.name} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} aria-invalid={!!nameError} />
            </Field>
            <Field label="Description" htmlFor={ids.desc}>
              <Textarea id={ids.desc} rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
        </SettingsCard>
      </form>

      <SettingsCard
        title="Storage"
        description="Labels are the source of truth on disk; the server never moves your images."
        footer={
          <Button variant="secondary" onClick={() => rescan.mutate()} loading={rescan.isPending} disabled={isIndexing}>
            {!rescan.isPending && <RefreshCw />}
            Rescan folder
          </Button>
        }
      >
        <dl className="flex flex-col">
          <InfoRow label="Image folder">
            <span className="break-all font-mono text-xs">{project.image_dir || '—'}</span>
          </InfoRow>
          <InfoRow label="Label folder">
            {project.label_dir ? (
              <span className="break-all font-mono text-xs">{project.label_dir}</span>
            ) : (
              <span className="text-muted">Same folder as the images</span>
            )}
          </InfoRow>
          <InfoRow label="Label format">
            <span className="flex flex-wrap items-center gap-2">
              <FormatBadge format={project.label_format} />
              <span className="text-muted">{FORMAT_DESCRIPTIONS[project.label_format]}</span>
            </span>
          </InfoRow>
          <InfoRow label="Images">
            <span className="flex items-center gap-2 tabular-nums">
              {formatNumber(project.image_count)}
              {isIndexing && (
                <span className="flex items-center gap-1.5 text-muted">
                  <Spinner className="size-3" /> indexing
                  {indexing && indexing.total > 0 && ` ${formatNumber(indexing.done)} / ${formatNumber(indexing.total)}`}
                </span>
              )}
            </span>
          </InfoRow>
          <InfoRow label="Created">{formatDateTime(project.created_at)}</InfoRow>
        </dl>
      </SettingsCard>
    </div>
  )
}
