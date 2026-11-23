import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheck, MapPin, MessageSquare, MoreHorizontal, Pencil, RotateCcw, Send, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { addComment, deleteComment, getComments, updateComment } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { qk } from '@/lib/queryKeys'
import { upsertComment } from '@/lib/cacheUpdates'
import { formatDateTime, relativeTime } from '@/lib/format'
import type { Comment } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useSession } from '@/stores/session'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { ErrorState, SkeletonRows } from '@/components/ui/Feedback'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { MentionTextarea } from '@/components/MentionTextarea'
import { MessageBody } from '@/components/MessageBody'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { useAnnotator } from './store'
import { useWorkspace } from './workspaceContext'

function CommentItem({ comment, pinNumber }: { comment: Comment; pinNumber: number | null }) {
  const ws = useWorkspace()
  const qc = useQueryClient()
  const me = useSession((s) => s.user)
  const focused = useAnnotator((s) => s.focusCommentId === comment.id)
  const ref = useRef<HTMLLIElement>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const members = ws.project.members.map((m) => m.user)
  const usernames = useMemo(() => new Set(members.map((u) => u.username)), [members])
  const mine = comment.user.id === me?.id
  const canResolve = ws.project.permissions.can_edit
  const canDelete = mine || ws.project.permissions.can_manage

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focused])

  const patch = useMutation({
    mutationFn: (body: { body?: string; resolved?: boolean }) => updateComment(ws.projectId, comment.id, body),
    onSuccess: (c) => {
      upsertComment(qc, c)
      void qc.invalidateQueries({ queryKey: qk.threads(ws.projectId) })
    },
    onError: (err) => toast.error('Could not update the comment', { description: errorMessage(err) }),
  })

  if (comment.deleted) {
    return <li className="px-3 py-2 text-sm italic text-dim">Comment deleted</li>
  }

  return (
    <li
      ref={ref}
      className={cn(
        'group relative px-3 py-2.5 transition-colors',
        focused && 'bg-accent-soft',
        comment.resolved && 'opacity-70',
      )}
    >
      <div className="flex items-center gap-2">
        <Avatar user={comment.user} size="sm" showPresence />
        <span className="truncate text-sm font-semibold text-fg">{comment.user.display_name}</span>
        <time className="shrink-0 text-xs text-dim" dateTime={comment.created_at} title={formatDateTime(comment.created_at)}>
          {relativeTime(comment.created_at)}
        </time>
        {comment.edited_at && <span className="text-xs text-dim">(edited)</span>}
        <span className="flex-1" />
        {pinNumber !== null && comment.pin && (
          <button
            type="button"
            onClick={() => {
              useAnnotator.getState().setShowPins(true)
              useAnnotator.getState().focusComment(comment.id)
            }}
            className="flex items-center gap-0.5 rounded px-1 text-2xs font-semibold text-accent-text hover:bg-hover"
            aria-label={`Pin ${pinNumber} at ${Math.round(comment.pin.x)}, ${Math.round(comment.pin.y)}`}
          >
            <MapPin className="size-3" aria-hidden />
            {pinNumber}
          </button>
        )}
        {(mine || canDelete) && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Comment actions"
              className="grid size-6 place-items-center rounded-md text-dim opacity-0 hover:bg-hover hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {mine && (
                <DropdownMenuItem
                  icon={<Pencil />}
                  onSelect={() => {
                    setDraft(comment.body)
                    setEditing(true)
                  }}
                >
                  Edit
                </DropdownMenuItem>
              )}
              {canDelete && (
                <DropdownMenuItem icon={<Trash2 />} danger onSelect={() => setConfirmDelete(true)}>
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <MentionTextarea
            value={draft}
            onChange={setDraft}
            users={members}
            autoFocus
            aria-label="Edit comment"
            onSubmit={() => {
              if (!draft.trim()) return
              patch.mutate({ body: draft.trim() }, { onSuccess: () => setEditing(false) })
            }}
            onEscape={() => setEditing(false)}
          />
          <div className="flex justify-end gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="xs"
              variant="primary"
              loading={patch.isPending}
              disabled={!draft.trim()}
              onClick={() => patch.mutate({ body: draft.trim() }, { onSuccess: () => setEditing(false) })}
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <MessageBody body={comment.body} usernames={usernames} className="mt-1.5 pl-8" />
      )}
      <div className="mt-1.5 flex items-center gap-2 pl-8">
        {comment.resolved ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-ok">
            <CircleCheck className="size-3" aria-hidden />
            Resolved
          </span>
        ) : null}
        {canResolve && (
          <Button
            size="xs"
            variant="ghost"
            className="h-5 px-1.5"
            disabled={patch.isPending}
            onClick={() => patch.mutate({ resolved: !comment.resolved })}
          >
            {comment.resolved ? <RotateCcw /> : <CircleCheck />}
            {comment.resolved ? 'Reopen' : 'Resolve'}
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        danger
        title="Delete this comment?"
        description="It will be removed from the thread for everyone."
        confirmLabel="Delete"
        onConfirm={async () => {
          try {
            await deleteComment(ws.projectId, comment.id)
            upsertComment(qc, { ...comment, deleted: true, body: '' })
            void qc.invalidateQueries({ queryKey: qk.threads(ws.projectId) })
          } catch (err) {
            toast.error('Could not delete the comment', { description: errorMessage(err) })
            throw err
          }
        }}
      />
    </li>
  )
}

/** Image comment thread with optional pins placed on the canvas, mentions, resolve. */
export function CommentsTab() {
  const ws = useWorkspace()
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const [show, setShow] = useState<'open' | 'all'>('all')
  const placingPin = useAnnotator((s) => s.placingPin)
  const pendingPin = useAnnotator((s) => s.pendingPin)
  const setPlacingPin = useAnnotator((s) => s.setPlacingPin)
  const setPendingPin = useAnnotator((s) => s.setPendingPin)
  const listRef = useRef<HTMLUListElement>(null)
  const members = ws.project.members.map((m) => m.user)

  const query = useQuery({
    queryKey: qk.comments(ws.projectId, ws.imageId),
    queryFn: ({ signal }) => getComments(ws.projectId, ws.imageId, { signal }),
    staleTime: 30_000,
  })

  const pinNumbers = useMemo(() => {
    const m = new Map<number, number>()
    let n = 0
    for (const c of query.data ?? []) if (c.pin && !c.deleted) m.set(c.id, ++n)
    return m
  }, [query.data])

  const send = useMutation({
    mutationFn: () => addComment(ws.projectId, ws.imageId, body.trim(), pendingPin),
    onSuccess: (c) => {
      upsertComment(qc, c)
      void qc.invalidateQueries({ queryKey: qk.threads(ws.projectId) })
      setBody('')
      setPendingPin(null)
      requestAnimationFrame(() => listRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' }))
    },
    onError: (err) => toast.error('Could not post the comment', { description: errorMessage(err) }),
  })

  const comments = (query.data ?? []).filter((c) => show === 'all' || (!c.resolved && !c.deleted))
  const openCount = (query.data ?? []).filter((c) => !c.resolved && !c.deleted).length

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-sm text-muted">
          {openCount} open · {(query.data ?? []).filter((c) => !c.deleted).length} total
        </span>
        <SegmentedControl
          className="ml-auto"
          size="sm"
          aria-label="Which comments to show"
          value={show}
          onValueChange={setShow}
          options={[
            { value: 'all', label: 'All' },
            { value: 'open', label: 'Open' },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isPending ? (
          <SkeletonRows rows={4} className="p-3" rowClassName="h-12" />
        ) : query.isError ? (
          <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
        ) : comments.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 px-6 py-10 text-center">
            <MessageSquare className="size-5 text-dim" aria-hidden />
            <div className="text-sm font-medium text-fg">{show === 'open' ? 'No open comments' : 'No comments yet'}</div>
            <div className="text-xs text-muted">Ask a question or leave a note. Add a pin to point at a spot on the image.</div>
          </div>
        ) : (
          <ul ref={listRef} className="divide-y divide-line/70">
            {comments.map((c) => (
              <CommentItem key={c.id} comment={c} pinNumber={pinNumbers.get(c.id) ?? null} />
            ))}
          </ul>
        )}
      </div>
      <div className="shrink-0 border-t border-line p-2.5">
        {pendingPin && (
          <div className="mb-1.5 flex items-center gap-1.5 text-xs text-accent-text">
            <MapPin className="size-3" aria-hidden />
            Pin at {pendingPin.x}, {pendingPin.y}
            <IconButton size="xs" label="Remove pin" icon={<X />} onClick={() => setPendingPin(null)} noTooltip />
          </div>
        )}
        <MentionTextarea
          value={body}
          onChange={setBody}
          users={members}
          placeholder="Comment on this image… (@ to mention)"
          aria-label="New comment"
          onSubmit={() => body.trim() && !send.isPending && send.mutate()}
        />
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button
            size="xs"
            variant={placingPin ? 'primary' : 'ghost'}
            aria-pressed={placingPin}
            onClick={() => setPlacingPin(!placingPin)}
          >
            <MapPin />
            {placingPin ? 'Click the image…' : pendingPin ? 'Move pin' : 'Add pin'}
          </Button>
          <span className="flex-1" />
          <Button size="xs" variant="primary" loading={send.isPending} disabled={!body.trim()} onClick={() => send.mutate()}>
            <Send />
            Comment
          </Button>
        </div>
      </div>
    </div>
  )
}
