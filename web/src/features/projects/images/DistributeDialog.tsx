import { useId, useState } from 'react'
import { Shuffle } from 'lucide-react'
import type { BulkBody, Member } from '@/lib/types'
import { ROLE_LABELS } from '@/lib/status'
import { formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Field } from '@/components/ui/Field'
import { Input } from '@/components/ui/Input'
import { Avatar } from '@/components/ui/Avatar'

interface DistributeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  members: Member[]
  /** How many images the target covers (selection or the whole filter). */
  count: number
  scopeLabel: string
  target: Pick<BulkBody, 'image_ids' | 'filter'>
  pending: boolean
  onSubmit: (body: BulkBody) => void
}

/** Split images evenly (in natural order) between chosen members. */
export function DistributeDialog({ open, onOpenChange, members, count, scopeLabel, target, pending, onSubmit }: DistributeDialogProps) {
  const limitId = useId()
  const editors = members.filter((m) => m.role !== 'viewer')
  const [picked, setPicked] = useState<Set<number>>(
    () => new Set(editors.filter((m) => m.role === 'annotator').map((m) => m.user.id)),
  )
  const [limit, setLimit] = useState('')
  const limitNum = limit.trim() ? Math.max(1, Math.floor(Number(limit))) : null
  const limitInvalid = !!limit.trim() && !Number.isFinite(Number(limit))
  const effective = limitNum ? Math.min(limitNum, count) : count
  const each = picked.size ? Math.ceil(effective / picked.size) : 0

  function toggle(id: number, on: boolean) {
    setPicked((p) => {
      const next = new Set(p)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent
        size="md"
        title="Distribute images evenly"
        description={`Assign ${scopeLabel} in natural order, split between the people you pick. Existing assignments are replaced.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={pending}
              disabled={picked.size === 0 || limitInvalid || count === 0}
              onClick={() =>
                onSubmit({ ...target, action: 'distribute', user_ids: [...picked], limit: limitNum ?? undefined })
              }
            >
              <Shuffle />
              Distribute {formatNumber(effective)}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
            {editors.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted">
                No members can annotate yet. Add annotators in Settings → Members.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {editors.map((m) => {
                  const id = `${limitId}-m${m.user.id}`
                  const on = picked.has(m.user.id)
                  return (
                    <li key={m.user.id} className={cn('flex items-center gap-3 px-3 py-2', on && 'bg-accent-soft/50')}>
                      <Checkbox id={id} checked={on} onCheckedChange={(v) => toggle(m.user.id, v === true)} />
                      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5">
                        <Avatar user={m.user} size="sm" showPresence tooltip={false} />
                        <span className="min-w-0 flex-1 truncate text-base text-fg">{m.user.display_name}</span>
                        <span className="text-xs text-dim">{ROLE_LABELS[m.role]}</span>
                        <span className="w-24 text-right text-xs tabular-nums text-muted">
                          {formatNumber(m.assigned_count)} assigned
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
          <Field
            label="Limit"
            htmlFor={limitId}
            hint={`Optional. Only distribute the first N of ${formatNumber(count)} images.`}
            error={limitInvalid ? 'Enter a whole number.' : null}
          >
            <Input
              id={limitId}
              inputMode="numeric"
              placeholder="All"
              className="w-32"
              value={limit}
              onChange={(e) => setLimit(e.target.value.replace(/[^\d]/g, ''))}
              aria-describedby={`${limitId}-desc`}
            />
          </Field>
          <p className="rounded-md bg-panel-2 px-3 py-2 text-sm text-muted">
            {picked.size === 0 ? (
              'Pick at least one person.'
            ) : (
              <>
                About <span className="font-medium text-fg">{formatNumber(each)}</span> images each for{' '}
                {picked.size === 1 ? '1 person' : `${picked.size} people`}.
              </>
            )}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
