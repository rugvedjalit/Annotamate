import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CircleAlert, GitMerge, ShieldCheck, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { deleteClass } from '@/lib/endpoints'
import { ApiError, errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import type { ClassDeleteStrategy, LabelFormat, ProjectClass } from '@/lib/types'
import { formatNumber } from '@/lib/format'
import { pluralize } from '@/lib/utils'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { RadioCards } from '../RadioCards'

interface DeleteClassDialogProps {
  projectId: number
  cls: ProjectClass
  classes: ProjectClass[]
  format: LabelFormat
  /** From stats, when known. */
  usage: { boxes: number; images: number } | undefined
  onOpenChange: (open: boolean) => void
}

/** Delete a class with an explicit strategy: only if unused, delete its boxes, or merge into another class. */
export function DeleteClassDialog({ projectId, cls, classes, format, usage, onOpenChange }: DeleteClassDialogProps) {
  const qc = useQueryClient()
  const others = classes.filter((c) => c.id !== cls.id)
  const knownUsed = (usage?.boxes ?? 0) > 0
  const [strategy, setStrategy] = useState<ClassDeleteStrategy>(knownUsed ? (others.length ? 'merge' : 'delete_boxes') : 'forbid')
  const [mergeInto, setMergeInto] = useState<string | undefined>(others[0] ? String(others[0].id) : undefined)
  const [inUse, setInUse] = useState<number | null>(null)

  const mutation = useMutation({
    mutationFn: () => deleteClass(projectId, cls.id, strategy, strategy === 'merge' ? Number(mergeInto) : undefined),
    onSuccess: (res) => {
      const target = others.find((c) => String(c.id) === mergeInto)
      toast.success(strategy === 'merge' && target ? `Merged “${cls.name}” into “${target.name}”` : `Deleted class “${cls.name}”`, {
        description: res.rewritten_files ? `${pluralize(res.rewritten_files, 'label file')} rewritten.` : undefined,
      })
      void qc.invalidateQueries({ queryKey: qk.project(projectId) })
      void qc.invalidateQueries({ queryKey: qk.stats(projectId) })
      void qc.invalidateQueries({ queryKey: qk.imagesAll(projectId) })
      onOpenChange(false)
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'in_use') {
        const n = typeof err.extra.images === 'number' ? err.extra.images : null
        setInUse(n ?? 0)
        if (strategy === 'forbid') setStrategy(others.length ? 'merge' : 'delete_boxes')
        return
      }
      toast.error('Could not delete the class', { description: errorMessage(err) })
    },
  })

  const canSubmit = strategy !== 'merge' || !!mergeInto

  return (
    <Dialog open onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <DialogContent
        size="md"
        title={
          <span className="flex items-center gap-2">
            Delete class
            <span className="inline-flex items-center gap-1.5 rounded-md bg-panel-2 px-2 py-0.5 text-base font-medium">
              <span className="size-2.5 rounded-sm" style={{ background: cls.color }} aria-hidden />
              {cls.name}
            </span>
          </span>
        }
        description={
          usage
            ? usage.boxes > 0
              ? `Used by ${pluralize(usage.boxes, 'box', 'boxes')} in ${pluralize(usage.images, 'image')}.`
              : 'No boxes use this class.'
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
              Cancel
            </Button>
            <Button variant="danger" loading={mutation.isPending} disabled={!canSubmit} onClick={() => mutation.mutate()}>
              {strategy === 'merge' ? 'Merge and delete' : 'Delete class'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {inUse !== null && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-fg">
              <CircleAlert className="mt-px size-4 shrink-0 text-warn" aria-hidden />
              <span>
                “{cls.name}” is still used{inUse > 0 ? ` in ${formatNumber(inUse)} ${inUse === 1 ? 'image' : 'images'}` : ''}. Choose
                whether to delete those boxes or merge them into another class.
              </span>
            </div>
          )}
          <RadioCards
            aria-label="What happens to boxes of this class"
            value={strategy}
            onValueChange={setStrategy}
            options={[
              {
                value: 'forbid',
                icon: <ShieldCheck className="size-4 text-muted" />,
                title: 'Only if unused',
                description: 'Safe: the server refuses if any label still uses this class.',
              },
              {
                value: 'merge',
                icon: <GitMerge className="size-4 text-muted" />,
                title: 'Merge into another class',
                description: 'Every box of this class is relabelled.',
                disabled: others.length === 0,
              },
              {
                value: 'delete_boxes',
                icon: <Trash2 className="size-4 text-danger" />,
                title: 'Delete its boxes',
                description: 'Removes every box of this class from all label files. This cannot be undone.',
              },
            ]}
          />
          {strategy === 'merge' && (
            <Select
              aria-label="Merge into"
              value={mergeInto}
              onValueChange={setMergeInto}
              placeholder="Choose a class"
              items={others.map((c) => ({
                value: String(c.id),
                label: c.name,
                icon: <span className="size-2.5 shrink-0 rounded-sm" style={{ background: c.color }} />,
              }))}
            />
          )}
          {format === 'yolo' && (
            <p className="text-xs text-muted">
              YOLO stores class positions: classes after #{cls.index} move up by one, and label files are rewritten
              automatically to match.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
