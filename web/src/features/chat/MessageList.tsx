import { useState } from 'react'
import { Link } from 'react-router'
import { ImageIcon, Pencil, Trash } from 'lucide-react'
import type { ChatMessage, UserBrief } from '@/lib/types'
import { formatDateTime, formatTime } from '@/lib/format'
import { thumbUrl } from '@/lib/endpoints'
import { cn } from '@/lib/utils'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/ui/Button'
import { MessageBody } from '@/components/MessageBody'
import { MentionTextarea } from '@/components/MentionTextarea'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import type { ThreadRow } from './thread'
import { DaySeparator, GroupAvatar, MessageHeader, UnreadDivider } from './ThreadParts'
import { useDeleteChat, useEditChat } from './useChatActions'

interface MessageListProps {
  projectId: number
  rows: ThreadRow<ChatMessage>[]
  meId: number
  canManage: boolean
  members: readonly UserBrief[]
  usernames: ReadonlySet<string>
}

export function MessageList({ projectId, rows, meId, canManage, members, usernames }: MessageListProps) {
  return (
    <div className="flex flex-col pb-2" role="log" aria-label="Chat messages">
      {rows.map((row) => {
        if (row.kind === 'day') return <DaySeparator key={row.key} label={row.label} />
        if (row.kind === 'unread') return <UnreadDivider key={row.key} />
        const own = row.message.user.id === meId
        return (
          <ChatMessageItem
            key={row.key}
            projectId={projectId}
            message={row.message}
            showHeader={row.showHeader}
            own={own}
            canDelete={own || canManage}
            members={members}
            usernames={usernames}
          />
        )
      })}
    </div>
  )
}

interface ItemProps {
  projectId: number
  message: ChatMessage
  showHeader: boolean
  own: boolean
  canDelete: boolean
  members: readonly UserBrief[]
  usernames: ReadonlySet<string>
}

function ChatMessageItem({ projectId, message: m, showHeader, own, canDelete, members, usernames }: ItemProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const edit = useEditChat(projectId)
  const del = useDeleteChat(projectId)

  function startEdit() {
    setDraft(m.body)
    setEditing(true)
  }

  function saveEdit() {
    const body = draft.trim()
    if (!body || body === m.body) {
      setEditing(false)
      return
    }
    edit.mutate({ id: m.id, body }, { onSuccess: () => setEditing(false) })
  }

  return (
    <div
      className={cn(
        'group relative flex gap-2.5 px-4 transition-colors hover:bg-hover/50',
        showHeader ? 'mt-2 pt-1' : 'pt-0.5',
        editing && 'bg-accent-soft hover:bg-accent-soft',
      )}
    >
      <div className="w-8 shrink-0">
        {showHeader ? (
          <GroupAvatar user={m.user} />
        ) : (
          <time
            dateTime={m.created_at}
            title={formatDateTime(m.created_at)}
            className="invisible block pt-0.5 text-right text-[10px] leading-5 text-dim group-hover:visible"
          >
            {formatTime(m.created_at)}
          </time>
        )}
      </div>
      <div className="min-w-0 flex-1 pb-0.5">
        {showHeader && <MessageHeader user={m.user} createdAt={m.created_at} />}
        {m.deleted ? (
          <div className="text-base italic leading-5 text-dim">Message deleted</div>
        ) : editing ? (
          <div className="flex flex-col gap-1.5 py-1">
            <MentionTextarea
              value={draft}
              onChange={setDraft}
              onSubmit={saveEdit}
              onEscape={() => setEditing(false)}
              users={members}
              autoFocus
              aria-label="Edit message"
            />
            <div className="flex items-center gap-1.5 text-2xs text-dim">
              <span>Enter to save · Esc to cancel</span>
              <Button size="xs" variant="ghost" className="ml-auto" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="xs" variant="primary" loading={edit.isPending} onClick={saveEdit}>
                Save
              </Button>
            </div>
          </div>
        ) : (
          <>
            <MessageBody body={m.body} usernames={usernames} />
            {m.edited_at && (
              <span className="text-2xs text-dim" title={formatDateTime(m.edited_at)}>
                (edited)
              </span>
            )}
            {m.image && <ImageAttachment projectId={projectId} image={m.image} />}
          </>
        )}
      </div>
      {!m.deleted && !editing && (own || canDelete) && (
        <div className="absolute -top-2 right-3 hidden items-center rounded-md border border-line bg-elevated p-0.5 shadow-pop group-focus-within:flex group-hover:flex">
          {own && <IconButton size="xs" label="Edit message" icon={<Pencil />} onClick={startEdit} />}
          {canDelete && (
            <IconButton
              size="xs"
              variant="danger"
              label="Delete message"
              icon={<Trash />}
              onClick={() => setConfirmDelete(true)}
            />
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        danger
        title="Delete this message?"
        description={own ? 'It will be removed for everyone in the project.' : `This deletes ${m.user.display_name}'s message for everyone.`}
        confirmLabel="Delete"
        onConfirm={() => del.mutateAsync(m)}
      />
    </div>
  )
}

function ImageAttachment({ projectId, image }: { projectId: number; image: { id: number; filename: string } }) {
  const [failed, setFailed] = useState(false)
  return (
    <Link
      to={`/p/${projectId}/annotate/${image.id}`}
      className="mt-1.5 flex w-full max-w-[260px] items-center gap-2.5 rounded-lg border border-line bg-panel-2 p-1.5 pr-3 transition-colors hover:border-line-strong hover:bg-hover"
      aria-label={`Open ${image.filename} in the annotator`}
    >
      <div className="grid h-12 w-16 shrink-0 place-items-center overflow-hidden rounded-md bg-canvas">
        {failed ? (
          <ImageIcon className="size-4 text-dim" aria-hidden />
        ) : (
          <img
            src={thumbUrl(projectId, image.id, 128)}
            alt=""
            loading="lazy"
            width={64}
            height={48}
            onError={() => setFailed(true)}
            className="h-12 w-16 object-cover"
          />
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate font-mono text-xs text-fg">{image.filename}</div>
        <div className="text-2xs text-accent-text">Open in annotator</div>
      </div>
    </Link>
  )
}
