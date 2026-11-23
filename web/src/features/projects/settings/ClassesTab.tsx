import { useId, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Plus, Tag, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClass, updateClass } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import { setProjectClasses } from '@/lib/cacheUpdates'
import { CLASS_PALETTE, nextClassColor } from '@/lib/colors'
import { formatNumber } from '@/lib/format'
import type { Project, ProjectClass } from '@/lib/types'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover'
import { EmptyState } from '@/components/ui/Feedback'
import { Tooltip } from '@/components/ui/Tooltip'
import { ColorSwatches } from '@/components/ColorSwatches'
import { useProjectStats } from '../overview/chartUtils'
import { DeleteClassDialog } from './DeleteClassDialog'
import { SettingsCard } from './SettingsCard'

function ColorButton({ color, label, onChange }: { color: string; label: string; onChange: (c: string) => void }) {
  return (
    <Popover>
      <Tooltip content={label}>
        <PopoverTrigger
          aria-label={label}
          className="grid size-7 shrink-0 place-items-center rounded-md border border-line bg-panel-2 hover:border-line-strong"
        >
          <span className="size-3.5 rounded-sm" style={{ background: color }} />
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="start" className="w-[232px] p-3">
        <ColorSwatches value={color} onChange={onChange} colors={CLASS_PALETTE} allowCustom label={label} />
      </PopoverContent>
    </Popover>
  )
}

function ClassRow({
  cls,
  usage,
  onRename,
  onRecolor,
  onDelete,
  busy,
}: {
  cls: ProjectClass
  usage: { boxes: number; images: number } | undefined
  onRename: (name: string) => Promise<unknown>
  onRecolor: (color: string) => void
  onDelete: () => void
  busy: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(cls.name)

  async function commit() {
    const v = name.trim()
    if (!v || v === cls.name) {
      setEditing(false)
      setName(cls.name)
      return
    }
    try {
      await onRename(v)
      setEditing(false)
    } catch {
      // toast shown by the mutation; keep editing
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      void commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setEditing(false)
      setName(cls.name)
    }
  }

  return (
    <li className="group flex h-12 items-center gap-3 px-4">
      <span className="w-8 shrink-0 font-mono text-xs tabular-nums text-dim" title="Class index (YOLO id, line in classes.txt)">
        #{cls.index}
      </span>
      <ColorButton color={cls.color} label={`Colour of ${cls.name}`} onChange={onRecolor} />
      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <Input
            size="sm"
            autoFocus
            value={name}
            maxLength={100}
            aria-label={`Rename ${cls.name}`}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKeyDown}
            className="max-w-72"
          />
          <IconButton size="sm" label="Save name" icon={<Check />} onClick={() => void commit()} disabled={busy} />
          <IconButton
            size="sm"
            label="Cancel"
            icon={<X />}
            onClick={() => {
              setEditing(false)
              setName(cls.name)
            }}
          />
        </div>
      ) : (
        <button
          type="button"
          className="min-w-0 flex-1 truncate rounded px-1 text-left text-base text-fg hover:bg-hover"
          onDoubleClick={() => setEditing(true)}
          onClick={() => setEditing(true)}
          aria-label={`Rename ${cls.name}`}
        >
          {cls.name}
        </button>
      )}
      <span className="hidden w-40 shrink-0 text-right text-xs tabular-nums text-muted sm:block">
        {usage ? (
          <>
            <span className="text-fg">{formatNumber(usage.boxes)}</span> {usage.boxes === 1 ? 'box' : 'boxes'} ·{' '}
            {formatNumber(usage.images)} {usage.images === 1 ? 'image' : 'images'}
          </>
        ) : (
          '—'
        )}
      </span>
      <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        {!editing && <IconButton size="sm" label={`Rename ${cls.name}`} icon={<Pencil />} onClick={() => setEditing(true)} />}
        <IconButton size="sm" variant="danger" label={`Delete ${cls.name}`} icon={<Trash2 />} onClick={onDelete} />
      </div>
    </li>
  )
}

export function ClassesTab({ project }: { project: Project }) {
  const pid = project.id
  const qc = useQueryClient()
  const stats = useProjectStats(pid)
  const nameId = useId()
  const classes = project.classes
  const [name, setName] = useState('')
  const [color, setColor] = useState(() => nextClassColor(classes.map((c) => c.color)))
  const [deleting, setDeleting] = useState<ProjectClass | null>(null)
  const usageById = new Map(stats.data?.class_counts.map((c) => [c.class_id, { boxes: c.boxes, images: c.images }]))
  const duplicate = classes.some((c) => c.name.toLowerCase() === name.trim().toLowerCase())

  const create = useMutation({
    mutationFn: (body: { name: string; color: string }) => createClass(pid, body),
    onSuccess: (cls) => {
      const current = qc.getQueryData<Project>(qk.project(pid))?.classes ?? classes
      if (!current.some((c) => c.id === cls.id)) setProjectClasses(qc, pid, [...current, cls])
      toast.success(`Added class “${cls.name}”`)
      setName('')
      setColor(nextClassColor([...current, cls].map((c) => c.color)))
    },
    onError: (err) => toast.error('Could not add the class', { description: errorMessage(err) }),
  })

  const update = useMutation({
    mutationFn: ({ cls, body }: { cls: ProjectClass; body: { name?: string; color?: string } }) => updateClass(pid, cls.id, body),
    onSuccess: (updated, { body }) => {
      const current = qc.getQueryData<Project>(qk.project(pid))?.classes ?? classes
      setProjectClasses(qc, pid, current.map((c) => (c.id === updated.id ? updated : c)))
      if (body.name) {
        toast.success(`Renamed to “${updated.name}”`, {
          description: project.label_format === 'yolo' ? undefined : 'Label files are being updated in the background.',
        })
      }
    },
    onError: (err) => toast.error('Could not update the class', { description: errorMessage(err) }),
  })

  function add(e: FormEvent) {
    e.preventDefault()
    const v = name.trim()
    if (!v || duplicate) return
    create.mutate({ name: v, color })
  }

  return (
    <div className="flex flex-col gap-5">
      <SettingsCard
        title="Classes"
        description={
          project.label_format === 'yolo'
            ? 'The position (#) is the YOLO class id and the line in classes.txt. Renaming and recolouring never touch label files.'
            : 'Boxes store class names. Renaming rewrites label files in the background; colours are only used in the app.'
        }
      >
        <form onSubmit={add} className="flex flex-wrap items-center gap-2">
          <ColorButton color={color} label="Colour for the new class" onChange={setColor} />
          <Input
            id={nameId}
            aria-label="New class name"
            placeholder="New class name"
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
            className="w-auto min-w-56 flex-1"
            aria-invalid={duplicate}
          />
          <Button type="submit" variant="primary" disabled={!name.trim() || duplicate} loading={create.isPending}>
            {!create.isPending && <Plus />}
            Add class
          </Button>
          {duplicate && <p className="w-full text-xs text-danger">A class with this name already exists.</p>}
        </form>
      </SettingsCard>

      <section className="overflow-hidden rounded-xl border border-line bg-panel shadow-card" aria-label="Class list">
        {classes.length === 0 ? (
          <EmptyState compact icon={<Tag />} title="No classes yet" description="Add the first class above." />
        ) : (
          <ul className="divide-y divide-line">
            {classes.map((c) => (
              <ClassRow
                key={`${c.id}:${c.name}`}
                cls={c}
                usage={usageById.get(c.id) ?? (stats.data ? { boxes: 0, images: 0 } : undefined)}
                busy={update.isPending}
                onRename={(n) => update.mutateAsync({ cls: c, body: { name: n } })}
                onRecolor={(col) => update.mutate({ cls: c, body: { color: col } })}
                onDelete={() => setDeleting(c)}
              />
            ))}
          </ul>
        )}
      </section>

      {deleting && (
        <DeleteClassDialog
          projectId={pid}
          cls={deleting}
          classes={classes}
          format={project.label_format}
          usage={usageById.get(deleting.id) ?? (stats.data ? { boxes: 0, images: 0 } : undefined)}
          onOpenChange={(o) => !o && setDeleting(null)}
        />
      )}
    </div>
  )
}
