import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCheck, MessagesSquare, SendHorizontal } from 'lucide-react'
import type { DirectMessage, User, UserBrief } from '@/lib/types'
import { formatDateTime, formatTime, relativeTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { realtime, useIsOnline, useRealtime } from '@/stores/realtime'
import { useUi } from '@/stores/ui'
import { Avatar } from '@/components/ui/Avatar'
import { IconButton } from '@/components/ui/IconButton'
import { ErrorState, Skeleton, Spinner, EmptyState } from '@/components/ui/Feedback'
import { MessageBody } from '@/components/MessageBody'
import { MentionTextarea } from '@/components/MentionTextarea'
import { buildThreadRows, shouldSendTyping } from '@/features/chat/thread'
import { useThreadScroll } from '@/features/chat/useThreadScroll'
import { DaySeparator, GroupAvatar, JumpToLatest, MessageHeader, TypingIndicator } from '@/features/chat/ThreadParts'
import { useDirectMessages, useMarkDirectRead, useSendDirectMessage } from './useDirectMessages'

interface DirectThreadProps {
  me: User
  other: UserBrief
  /** Last seen time of the other person (from the users list), if known. */
  lastSeenAt: string | null
  /** Everyone that can be @mentioned. */
  mentionUsers: readonly UserBrief[]
}

/** One DM conversation: header, history (infinite scroll up), typing indicator and composer. */
export function DirectThread({ me, other, lastSeenAt, mentionUsers }: DirectThreadProps) {
  const userId = other.id
  const query = useDirectMessages(userId)
  const { messages } = query
  const online = useIsOnline(userId)
  const setActiveDm = useUi((s) => s.setActiveDmUserId)
  const markRead = useMarkDirectRead(userId)
  const send = useSendDirectMessage(userId, other)
  const [body, setBody] = useState('')
  const lastTyping = useRef(0)
  const typing = useRealtime((s) => userId in s.dmTyping)

  useEffect(() => {
    setActiveDm(userId)
    return () => setActiveDm(null)
  }, [userId, setActiveDm])

  // Read receipts: on open and whenever a new incoming message shows up.
  const lastIncoming = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.sender_id === userId) return messages[i]!
    return null
  }, [messages, userId])
  const lastIncomingId = lastIncoming?.id ?? null
  const lastIncomingUnread = !!lastIncoming && !lastIncoming.read_at
  const markReadMutate = markRead.mutate
  useEffect(() => {
    if (lastIncomingId === null || !lastIncomingUnread) return
    const t = setTimeout(() => markReadMutate(), 300)
    return () => clearTimeout(t)
  }, [lastIncomingId, lastIncomingUnread, markReadMutate])

  const briefs = useMemo(() => new Map<number, UserBrief>([[me.id, me], [other.id, other]]), [me, other])
  const rows = useMemo(() => buildThreadRows(messages, (m) => m.sender_id), [messages])
  const last = messages[messages.length - 1]
  const lastMine = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.sender_id === me.id) return messages[i]!
    return null
  }, [messages, me.id])

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const { onScroll, jumpToLatest, showJump } = useThreadScroll({
    ref: scrollRef,
    firstId: messages[0]?.id ?? null,
    lastId: last?.id ?? null,
    lastIsMine: last?.sender_id === me.id,
    hasOlder: !!query.hasNextPage,
    loadingOlder: query.isFetchingNextPage,
    loadOlder: () => void query.fetchNextPage(),
  })

  function submit() {
    const text = body.trim()
    if (!text || send.isPending) return
    // Clear right away; restore the draft if sending fails and nothing new was typed.
    setBody('')
    send.mutate(text, { onError: () => setBody((current) => (current.trim() ? current : text)) })
  }

  function onTyping() {
    const now = Date.now()
    if (shouldSendTyping(lastTyping.current, now)) {
      lastTyping.current = now
      realtime.sendTyping('dm', userId)
    }
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label={`Conversation with ${other.display_name}`}>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel px-5">
        <Avatar user={other} size="md" showPresence tooltip={false} />
        <div className="min-w-0">
          <div className="truncate text-md font-semibold leading-tight">{other.display_name}</div>
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <span className="font-mono">@{other.username}</span>
            <span aria-hidden>·</span>
            <span className={cn(online && 'text-ok')}>
              {online ? 'Online' : lastSeenAt ? `Last seen ${relativeTime(lastSeenAt)}` : 'Offline'}
            </span>
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain">
          <div className="mx-auto w-full max-w-3xl">
            {query.isPending ? (
              <div className="flex flex-col gap-5 p-5" role="status" aria-label="Loading messages">
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="flex gap-2.5">
                    <Skeleton className="size-8 shrink-0 rounded-full" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="h-3.5 w-[60%]" />
                    </div>
                  </div>
                ))}
              </div>
            ) : query.isError ? (
              <ErrorState title="Could not load this conversation" error={query.error} onRetry={() => void query.refetch()} />
            ) : messages.length === 0 ? (
              <EmptyState
                className="min-h-[50vh]"
                icon={<MessagesSquare />}
                title={`Say hello to ${other.display_name}`}
                description="Direct messages are private between the two of you."
              />
            ) : (
              <div className="flex flex-col py-3" role="log" aria-label="Messages">
                {query.isFetchingNextPage && (
                  <div className="flex justify-center py-2">
                    <Spinner className="size-3.5" label="Loading older messages" />
                  </div>
                )}
                {!query.hasNextPage && (
                  <div className="px-5 pb-2 pt-4 text-center text-2xs text-dim">
                    This is the beginning of your conversation with {other.display_name}.
                  </div>
                )}
                {rows.map((row) => {
                  if (row.kind === 'day') return <DaySeparator key={row.key} label={row.label} />
                  if (row.kind === 'unread') return null
                  const m = row.message
                  return (
                    <DmRow
                      key={row.key}
                      message={m}
                      author={briefs.get(m.sender_id) ?? other}
                      showHeader={row.showHeader}
                      seen={!!lastMine && lastMine.id === m.id && !!m.read_at}
                    />
                  )
                })}
              </div>
            )}
          </div>
        </div>
        {showJump && <JumpToLatest onClick={jumpToLatest} />}
      </div>

      <div className="mx-auto w-full max-w-3xl">
        <TypingIndicator users={typing ? [other] : []} />
        <div className="flex items-end gap-1.5 px-5 pb-4 pt-1">
          <div className="min-w-0 flex-1">
            <MentionTextarea
              value={body}
              onChange={setBody}
              onSubmit={submit}
              onTyping={onTyping}
              users={mentionUsers}
              autoFocus
              maxRows={8}
              placeholder={`Message ${other.display_name}`}
              aria-label={`Message ${other.display_name}`}
            />
          </div>
          <IconButton
            label="Send message"
            shortcut="Enter"
            variant="solid"
            size="lg"
            icon={<SendHorizontal />}
            disabled={!body.trim() || send.isPending}
            onClick={submit}
            className={cn('mb-px', !body.trim() && 'bg-panel-2 text-dim shadow-none')}
          />
        </div>
      </div>
    </section>
  )
}

function DmRow({ message: m, author, showHeader, seen }: { message: DirectMessage; author: UserBrief; showHeader: boolean; seen: boolean }) {
  return (
    <div className={cn('group flex gap-2.5 px-5 hover:bg-hover/40', showHeader ? 'mt-2.5 pt-1' : 'pt-0.5')}>
      <div className="w-8 shrink-0">
        {showHeader ? (
          <GroupAvatar user={author} />
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
        {showHeader && <MessageHeader user={author} createdAt={m.created_at} />}
        <MessageBody body={m.body} />
        {seen && (
          <div className="mt-0.5 flex items-center gap-1 text-2xs text-dim" title={formatDateTime(m.read_at)}>
            <CheckCheck className="size-3 text-accent-text" aria-hidden />
            Seen {relativeTime(m.read_at)}
          </div>
        )}
      </div>
    </div>
  )
}
