import type { ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Flag, UserMinus, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { updateImage } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import { upsertImageItem } from '@/lib/cacheUpdates'
import { formatDateTime, relativeTime } from '@/lib/format'
import { useSession } from '@/stores/session'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { StatusBadge } from '@/components/StatusIcon'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ActivityFeed } from '@/features/activity/ActivityFeed'
import { useWorkspace } from './workspaceContext'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_1fr] items-start gap-2 py-1.5 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-fg">{children}</dd>
    </div>
  )
}

const UNASSIGNED = 'none'

/** File details, assignment / claim, status, flag and this image's activity. */
export function InfoTab() {
  const ws = useWorkspace()
  const qc = useQueryClient()
  const me = useSession((s) => s.user)
  const image = ws.image
  const perms = ws.project.permissions

  const assign = useMutation({
    mutationFn: (assigneeId: number | null) => updateImage(ws.projectId, ws.imageId, { assignee_id: assigneeId }),
    onSuccess: (item) => {
      upsertImageItem(qc, ws.projectId, item)
      void qc.invalidateQueries({ queryKey: qk.project(ws.projectId) })
      toast.success(item.assignee ? `Assigned to ${item.assignee.display_name}` : 'Unassigned')
    },
    onError: (err) => toast.error('Could not change the assignment', { description: errorMessage(err) }),
  })

  if (!image || !me) return null
  const assignedToMe = image.assignee?.id === me.id

  return (
    <div className="h-full overflow-y-auto">
      <dl className="border-b border-line px-3 py-2">
        <Row label="File">
          <span className="break-all font-mono text-xs">{image.rel_path}</span>
        </Row>
        <Row label="Size">
          <span className="font-mono text-xs">{image.width && image.height ? `${image.width} × ${image.height} px` : 'Unknown'}</span>
        </Row>
        <Row label="Label file">
          <span className="break-all font-mono text-xs">{image.label_path || '–'}</span>
        </Row>
        {perms.can_manage && ws.project.image_dir && (
          <Row label="Folder">
            <span className="break-all font-mono text-xs text-muted">{ws.project.image_dir}</span>
          </Row>
        )}
        <Row label="Position">
          <span className="font-mono text-xs">
            {image.position + 1} of {ws.project.image_count}
          </span>
        </Row>
      </dl>

      <dl className="border-b border-line px-3 py-2">
        <Row label="Status">
          <div className="flex flex-col items-start gap-1">
            <StatusBadge status={image.status} />
            {image.updated_at && (
              <span className="text-xs text-muted" title={formatDateTime(image.updated_at)}>
                Updated {relativeTime(image.updated_at)}
                {image.last_editor ? ` by ${image.last_editor.display_name}` : ''}
              </span>
            )}
          </div>
        </Row>
        <Row label="Assignee">
          <div className="flex flex-col items-start gap-1.5">
            {perms.can_manage ? (
              <Select
                size="sm"
                aria-label="Assignee"
                disabled={assign.isPending}
                value={image.assignee ? String(image.assignee.id) : UNASSIGNED}
                onValueChange={(v) => assign.mutate(v === UNASSIGNED ? null : Number(v))}
                items={[
                  { value: UNASSIGNED, label: 'Unassigned' },
                  ...ws.project.members
                    .filter((m) => m.role !== 'viewer')
                    .map((m) => ({
                      value: String(m.user.id),
                      label: m.user.display_name,
                      icon: <Avatar user={m.user} size="xs" tooltip={false} />,
                    })),
                ]}
              />
            ) : image.assignee ? (
              <span className="flex items-center gap-1.5">
                <Avatar user={image.assignee} size="xs" showPresence />
                {image.assignee.display_name}
              </span>
            ) : (
              <span className="text-muted">Unassigned</span>
            )}
            {!perms.can_manage && perms.can_edit && !image.assignee && (
              <Button size="xs" variant="secondary" loading={assign.isPending} onClick={() => assign.mutate(me.id)}>
                <UserPlus />
                Claim this image
              </Button>
            )}
            {!perms.can_manage && assignedToMe && (
              <Button size="xs" variant="ghost" loading={assign.isPending} onClick={() => assign.mutate(null)}>
                <UserMinus />
                Release
              </Button>
            )}
          </div>
        </Row>
        <Row label="Flag">
          <Button
            size="xs"
            variant={image.flagged ? 'warn' : 'secondary'}
            disabled={!perms.can_edit}
            aria-pressed={image.flagged}
            onClick={ws.toggleFlag}
          >
            <Flag />
            {image.flagged ? 'Flagged' : 'Flag for attention'}
          </Button>
        </Row>
      </dl>

      <div className="px-3 pb-1 pt-3 text-2xs font-bold uppercase tracking-[0.08em] text-muted">Activity on this image</div>
      <ErrorBoundary name="Activity">
        <ActivityFeed projectId={ws.projectId} imageId={ws.imageId} compact pageSize={20} className="px-3 pb-3" />
      </ErrorBoundary>
    </div>
  )
}
