import { useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, CircleAlert, Folder, Search } from 'lucide-react'
import { toast } from 'sonner'
import { createProject } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import type { CreateProjectBody, LabelFormat, ProjectSettings, Role } from '@/lib/types'
import { LABEL_FORMATS, ROLES } from '@/lib/types'
import { FORMAT_DESCRIPTIONS, FORMAT_LABELS, ROLE_LABELS } from '@/lib/status'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useUsers } from '@/hooks/queries'
import { useSession } from '@/stores/session'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Input, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { SwitchRow } from '@/components/ui/Switch'
import { Checkbox } from '@/components/ui/Checkbox'
import { Avatar } from '@/components/ui/Avatar'
import { ErrorState, SkeletonRows } from '@/components/ui/Feedback'
import { FolderBrowser } from './FolderBrowser'
import { ClassTagInput } from './ClassTagInput'
import { RadioCards } from './RadioCards'
import { folderBasename } from './projectUtils'

const STEPS = ['Image folder', 'Labels', 'Details', 'Members'] as const

type WorkflowSettings = Pick<ProjectSettings, 'require_review' | 'restrict_to_assigned' | 'annotators_can_add_classes' | 'exif_mode'>

interface NewProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function Stepper({ step, maxReached, onStep }: { step: number; maxReached: number; onStep: (i: number) => void }) {
  return (
    <ol className="flex items-center gap-1.5" aria-label="Steps">
      {STEPS.map((label, i) => {
        const done = i < step
        const active = i === step
        return (
          <li key={label} className="flex min-w-0 flex-1 items-center gap-1.5">
            <button
              type="button"
              disabled={i > maxReached}
              onClick={() => onStep(i)}
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-sm transition-colors enabled:hover:bg-hover disabled:cursor-default',
                active ? 'text-fg' : done ? 'text-muted' : 'text-dim',
              )}
            >
              <span
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded-full text-2xs font-bold',
                  active
                    ? 'bg-accent text-accent-fg'
                    : done
                      ? 'bg-accent-soft text-accent-text'
                      : 'border border-line-strong text-dim',
                )}
              >
                {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </span>
              <span className="truncate font-medium">{label}</span>
            </button>
            {i < STEPS.length - 1 && <span className="h-px min-w-3 flex-1 bg-line" aria-hidden />}
          </li>
        )
      })}
    </ol>
  )
}

function SelectedFolder({ path, count }: { path: string; count?: number }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-accent/40 bg-accent-soft px-3 py-2 text-sm">
      <Folder className="size-4 shrink-0 text-accent-text" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-fg" title={path}>
        {path}
      </span>
      {count !== undefined && <span className="shrink-0 tabular-nums text-muted">{formatNumber(count)} images</span>}
    </div>
  )
}

/** Admin wizard: folder → labels → details → members. */
export function NewProjectDialog({ open, onOpenChange }: NewProjectDialogProps) {
  const ids = { name: useId(), desc: useId(), classes: useId(), search: useId() }
  const navigate = useNavigate()
  const qc = useQueryClient()
  const me = useSession((s) => s.user)
  const [step, setStep] = useState(0)
  const [maxReached, setMaxReached] = useState(0)

  const [imageDir, setImageDir] = useState<string | null>(null)
  const [imageCount, setImageCount] = useState(0)
  const [recursive, setRecursive] = useState(false)
  const [labelMode, setLabelMode] = useState<'same' | 'separate'>('same')
  const [labelDir, setLabelDir] = useState<string | null>(null)
  const [format, setFormat] = useState<LabelFormat>('yolo')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [description, setDescription] = useState('')
  const [classes, setClasses] = useState<string[]>([])
  const [workflow, setWorkflow] = useState<WorkflowSettings>({
    require_review: false,
    restrict_to_assigned: false,
    annotators_can_add_classes: true,
    exif_mode: 'apply',
  })
  const [members, setMembers] = useState<Record<number, Role>>({})
  const [memberQuery, setMemberQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  const users = useUsers(false, open && step === 3)
  const candidates = useMemo(() => {
    const q = memberQuery.trim().toLowerCase()
    return (users.data ?? [])
      .filter((u) => u.id !== me?.id)
      .filter((u) => !q || u.display_name.toLowerCase().includes(q) || u.username.includes(q))
  }, [users.data, memberQuery, me?.id])

  const stepError = (s: number): string | null => {
    if (s === 0 && !imageDir) return 'Choose the folder that contains the images.'
    if (s === 1 && labelMode === 'separate' && !labelDir) return 'Choose the folder for the label files.'
    if (s === 2 && !name.trim()) return 'Give the project a name.'
    return null
  }
  const currentError = stepError(step)

  const create = useMutation({
    mutationFn: (body: CreateProjectBody) => createProject(body),
    onSuccess: (project) => {
      qc.setQueryData(qk.project(project.id), project)
      void qc.invalidateQueries({ queryKey: qk.projectsAll })
      toast.success(`Project “${project.name}” created`, {
        description: 'Images are being indexed in the background.',
      })
      onOpenChange(false)
      navigate(`/p/${project.id}`)
    },
    onError: (err) => setError(errorMessage(err)),
  })

  function goTo(next: number) {
    setTouched(false)
    setError(null)
    setStep(next)
    setMaxReached((m) => Math.max(m, next))
  }

  function nextStep() {
    setTouched(true)
    if (currentError) return
    goTo(step + 1)
  }

  function submit() {
    setTouched(true)
    for (let s = 0; s < STEPS.length; s++) {
      const e = stepError(s)
      if (e) {
        goTo(s)
        setTouched(true)
        return
      }
    }
    setError(null)
    create.mutate({
      name: name.trim(),
      description: description.trim() || undefined,
      image_dir: imageDir!,
      label_dir: labelMode === 'separate' ? labelDir : null,
      label_format: format,
      classes: classes.length ? classes : undefined,
      settings: { ...workflow, recursive },
      members: Object.entries(members).map(([id, role]) => ({ user_id: Number(id), role })),
    })
  }

  const memberCount = Object.keys(members).length

  return (
    <Dialog open={open} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent
        size="xl"
        title="New project"
        description="Point a project at an image folder on this server. Labels are written next to the images or into a folder you choose."
        bodyClassName="flex flex-col gap-5"
        footer={
          <>
            {(error || (touched && currentError)) && (
              <p role="alert" className="mr-auto flex min-w-0 items-center gap-1.5 text-sm text-danger">
                <CircleAlert className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{error ?? currentError}</span>
              </p>
            )}
            {step > 0 && (
              <Button variant="ghost" onClick={() => goTo(step - 1)} disabled={create.isPending}>
                Back
              </Button>
            )}
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={nextStep}>
                Next
              </Button>
            ) : (
              <Button variant="primary" onClick={submit} loading={create.isPending}>
                Create project
              </Button>
            )}
          </>
        }
      >
        <Stepper step={step} maxReached={maxReached} onStep={(i) => (i < step ? goTo(i) : !stepError(step) && goTo(i))} />

        {step === 0 && (
          <section className="flex flex-col gap-3" aria-label="Image folder">
            <FolderBrowser
              selected={imageDir}
              initialPath={imageDir}
              onSelect={(path, count) => {
                setImageDir(path)
                setImageCount(count)
                if (!nameEdited) setName(folderBasename(path))
              }}
            />
            {imageDir && <SelectedFolder path={imageDir} count={imageCount} />}
            <SwitchRow
              label="Include sub-folders"
              description="Scan nested folders recursively. Label files mirror the sub-folder structure."
              checked={recursive}
              onCheckedChange={setRecursive}
            />
          </section>
        )}

        {step === 1 && (
          <section className="flex flex-col gap-5" aria-label="Labels">
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-fg">Where should label files be written?</h3>
              <RadioCards
                aria-label="Label folder"
                columns={2}
                value={labelMode}
                onValueChange={setLabelMode}
                options={[
                  { value: 'same', title: 'Next to the images', description: 'Each label file sits beside its image.' },
                  { value: 'separate', title: 'A separate folder', description: 'Keep labels apart, e.g. a "labels/" folder.' },
                ]}
              />
            </div>
            {labelMode === 'separate' && (
              <div className="flex flex-col gap-3">
                <FolderBrowser
                  selected={labelDir}
                  initialPath={labelDir ?? imageDir}
                  selectLabel="Use for labels"
                  onSelect={(path) => setLabelDir(path)}
                />
                {labelDir && <SelectedFolder path={labelDir} />}
              </div>
            )}
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-fg">Label format</h3>
              <RadioCards
                aria-label="Label format"
                columns={3}
                value={format}
                onValueChange={setFormat}
                options={LABEL_FORMATS.map((f) => ({ value: f, title: FORMAT_LABELS[f], description: FORMAT_DESCRIPTIONS[f] }))}
              />
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="grid gap-5 md:grid-cols-2" aria-label="Details">
            <div className="flex flex-col gap-4">
              <Field label="Name" htmlFor={ids.name} required error={touched && !name.trim() ? 'Give the project a name.' : null}>
                <Input
                  id={ids.name}
                  value={name}
                  maxLength={100}
                  autoFocus
                  onChange={(e) => {
                    setName(e.target.value)
                    setNameEdited(true)
                  }}
                  aria-invalid={touched && !name.trim()}
                />
              </Field>
              <Field label="Description" htmlFor={ids.desc} hint="Optional. Shown on the project card.">
                <Textarea
                  id={ids.desc}
                  value={description}
                  rows={3}
                  maxLength={500}
                  onChange={(e) => setDescription(e.target.value)}
                  aria-describedby={`${ids.desc}-desc`}
                />
              </Field>
              <Field
                label="Classes"
                htmlFor={ids.classes}
                hint="Leave empty to read classes.txt or the classes used by existing label files. Colours can be changed later."
              >
                <ClassTagInput id={ids.classes} value={classes} onChange={setClasses} aria-describedby={`${ids.classes}-desc`} />
              </Field>
            </div>
            <div className="flex flex-col">
              <h3 className="mb-1 text-sm font-medium text-fg">Workflow</h3>
              <div className="divide-y divide-line rounded-lg border border-line px-3">
                <SwitchRow
                  label="Require review"
                  description="Submitted images go to a reviewer before they count as done."
                  checked={workflow.require_review}
                  onCheckedChange={(v) => setWorkflow((w) => ({ ...w, require_review: v }))}
                />
                <SwitchRow
                  label="Only edit assigned images"
                  description="Annotators can edit images assigned to them, or claim unassigned ones."
                  checked={workflow.restrict_to_assigned}
                  onCheckedChange={(v) => setWorkflow((w) => ({ ...w, restrict_to_assigned: v }))}
                />
                <SwitchRow
                  label="Annotators can add classes"
                  description="Otherwise only reviewers and managers can create classes."
                  checked={workflow.annotators_can_add_classes}
                  onCheckedChange={(v) => setWorkflow((w) => ({ ...w, annotators_can_add_classes: v }))}
                />
                <div className="flex items-center justify-between gap-4 py-2.5">
                  <div>
                    <div className="text-base text-fg">EXIF orientation</div>
                    <div className="mt-0.5 text-sm text-muted">“Apply” matches OpenCV and Ultralytics loaders.</div>
                  </div>
                  <Select
                    aria-label="EXIF orientation"
                    className="w-32"
                    size="sm"
                    value={workflow.exif_mode}
                    onValueChange={(v) => setWorkflow((w) => ({ ...w, exif_mode: v }))}
                    items={[
                      { value: 'apply', label: 'Apply' },
                      { value: 'ignore', label: 'Ignore' },
                    ]}
                  />
                </div>
              </div>
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="flex flex-col gap-3" aria-label="Members">
            <p className="text-sm text-muted">
              You are added as a manager automatically. Pick teammates and their roles; you can change this later.
            </p>
            <Input
              id={ids.search}
              aria-label="Search people"
              leftIcon={<Search />}
              placeholder="Search people"
              value={memberQuery}
              onChange={(e) => setMemberQuery(e.target.value)}
            />
            <div className="h-72 overflow-y-auto rounded-lg border border-line">
              {users.isPending ? (
                <SkeletonRows rows={5} className="p-2" rowClassName="h-10" />
              ) : users.isError ? (
                <ErrorState compact error={users.error} onRetry={() => void users.refetch()} />
              ) : candidates.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted">
                  {memberQuery ? 'Nobody matches this search.' : 'There are no other users yet. Create accounts in Administration → Users.'}
                </p>
              ) : (
                <ul className="divide-y divide-line">
                  {candidates.map((u) => {
                    const role = members[u.id]
                    const checked = role !== undefined
                    const checkboxId = `${ids.search}-u${u.id}`
                    return (
                      <li key={u.id} className={cn('flex items-center gap-3 px-3 py-2', checked && 'bg-accent-soft/50')}>
                        <Checkbox
                          id={checkboxId}
                          checked={checked}
                          onCheckedChange={(v) =>
                            setMembers((m) => {
                              const next = { ...m }
                              if (v === true) next[u.id] = 'annotator'
                              else delete next[u.id]
                              return next
                            })
                          }
                        />
                        <label htmlFor={checkboxId} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                          <Avatar user={u} size="sm" showPresence tooltip={false} />
                          <span className="min-w-0">
                            <span className="block truncate text-base text-fg">{u.display_name}</span>
                            <span className="block truncate font-mono text-xs text-dim">@{u.username}</span>
                          </span>
                        </label>
                        <Select
                          aria-label={`Role for ${u.display_name}`}
                          className="w-32"
                          size="sm"
                          disabled={!checked}
                          value={role ?? 'annotator'}
                          onValueChange={(v) => setMembers((m) => ({ ...m, [u.id]: v }))}
                          items={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
                        />
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg bg-panel-2 px-3 py-2.5 text-sm">
              <dt className="text-muted">Images</dt>
              <dd className="truncate font-mono text-fg" title={imageDir ?? ''}>
                {imageDir} <span className="font-sans text-muted">({formatNumber(imageCount)}{recursive ? ', with sub-folders' : ''})</span>
              </dd>
              <dt className="text-muted">Labels</dt>
              <dd className="truncate text-fg">
                {FORMAT_LABELS[format]} ·{' '}
                {labelMode === 'same' ? 'next to the images' : <span className="font-mono">{labelDir}</span>}
              </dd>
              <dt className="text-muted">Classes</dt>
              <dd className="text-fg">{classes.length ? classes.join(', ') : 'From existing files'}</dd>
              <dt className="text-muted">Members</dt>
              <dd className="text-fg">You{memberCount ? ` and ${memberCount} more` : ''}</dd>
            </dl>
          </section>
        )}
      </DialogContent>
    </Dialog>
  )
}
