import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { MessageSquare, X } from 'lucide-react'
import type { Project } from '@/lib/types'
import { useProjectContext } from '@/app/projectContext'
import { useUi } from '@/stores/ui'
import { useMe } from '@/stores/session'
import { useRealtime } from '@/stores/realtime'
import { IconButton } from '@/components/ui/IconButton'
import { EmptyState, ErrorState, Skeleton, Spinner } from '@/components/ui/Feedback'
import { buildThreadRows } from './thread'
import { useChatMessages } from './useChatMessages'
import { useMarkChatRead } from './useChatActions'
import { useThreadScroll } from './useThreadScroll'
import { JumpToLatest, TypingIndicator } from './ThreadParts'
import { MessageList } from './MessageList'
import { Composer } from './Composer'

/** Project chat drawer (right overlay, 360 px), available on every project page. */
export function ChatDrawer() {
  const open = useUi((s) => s.chatOpen)
  const { project } = useProjectContext()
  if (!open) return null
  return <ChatPanel key={project.id} project={project} />
}

function ChatPanel({ project }: { project: Project }) {
  const me = useMe()
  const setChatOpen = useUi((s) => s.setChatOpen)
  const pid = project.id
  const query = useChatMessages(pid)
  const { messages } = query
  const markRead = useMarkChatRead(pid)

  const members = useMemo(() => project.members.map((m) => m.user), [project.members])
  const usernames = useMemo(() => new Set(members.map((u) => u.username.toLowerCase())), [members])

  // "New messages" divider: decided once, from the unread count when the drawer opened.
  const [unreadAtOpen] = useState(project.unread_chat)
  const [firstUnreadId, setFirstUnreadId] = useState<number | null | undefined>(undefined)
  if (firstUnreadId === undefined && query.data) {
    const others = messages.filter((m) => m.user.id !== me.id)
    setFirstUnreadId(unreadAtOpen > 0 ? (others[Math.max(0, others.length - unreadAtOpen)]?.id ?? null) : null)
  }

  const rows = useMemo(() => buildThreadRows(messages, (m) => m.user.id, firstUnreadId ?? null), [messages, firstUnreadId])
  const last = messages[messages.length - 1]
  const lastId = last?.id ?? null

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const { onScroll, jumpToLatest, showJump } = useThreadScroll({
    ref: scrollRef,
    firstId: messages[0]?.id ?? null,
    lastId,
    lastIsMine: last?.user.id === me.id,
    hasOlder: !!query.hasNextPage,
    loadingOlder: query.isFetchingNextPage,
    loadOlder: () => void query.fetchNextPage(),
  })

  // Read marker: whenever the newest message changes while the drawer is open.
  const markReadMutate = markRead.mutate
  useEffect(() => {
    if (lastId === null) return
    const t = setTimeout(() => markReadMutate(lastId), 400)
    return () => clearTimeout(t)
  }, [lastId, markReadMutate])

  const typingMap = useRealtime((s) => s.chatTyping)
  const typingUsers = useMemo(
    () => Object.values(typingMap).filter((t) => t.user.id !== me.id).map((t) => t.user),
    [typingMap, me.id],
  )

  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      e.stopPropagation()
      setChatOpen(false)
    }
  }

  return (
    <aside
      aria-label={`${project.name} chat`}
      onKeyDown={onKeyDown}
      className="fixed bottom-0 right-0 top-12 z-40 flex w-[360px] max-w-full animate-slide-in-right flex-col border-l border-line bg-panel shadow-pop"
    >
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-3">
        <div className="grid size-7 place-items-center rounded-md bg-accent-soft text-accent-text">
          <MessageSquare className="size-3.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold leading-tight">Project chat</div>
          <div className="truncate text-xs text-muted">
            {project.name} · {project.member_count} {project.member_count === 1 ? 'member' : 'members'}
          </div>
        </div>
        <IconButton label="Close chat" shortcut="Escape" icon={<X />} onClick={() => setChatOpen(false)} />
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain">
          {query.isPending ? (
            <div className="flex flex-col gap-4 p-4" role="status" aria-label="Loading messages">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="flex gap-2.5">
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-3.5 w-[85%]" />
                  </div>
                </div>
              ))}
            </div>
          ) : query.isError ? (
            <ErrorState compact title="Could not load the chat" error={query.error} onRetry={() => void query.refetch()} />
          ) : messages.length === 0 ? (
            <EmptyState
              className="h-full"
              icon={<MessageSquare />}
              title="Start the conversation"
              description="Messages here are visible to everyone in this project. Use @ to mention someone."
            />
          ) : (
            <>
              {query.isFetchingNextPage && (
                <div className="flex justify-center py-2">
                  <Spinner className="size-3.5" label="Loading older messages" />
                </div>
              )}
              {!query.hasNextPage && (
                <div className="px-4 pb-1 pt-4 text-center text-2xs text-dim">This is the beginning of the project chat.</div>
              )}
              <MessageList
                projectId={pid}
                rows={rows}
                meId={me.id}
                canManage={project.permissions.can_manage}
                members={members}
                usernames={usernames}
              />
            </>
          )}
        </div>
        {showJump && <JumpToLatest onClick={jumpToLatest} />}
      </div>

      <TypingIndicator users={typingUsers} />
      <Composer projectId={pid} members={members} />
    </aside>
  )
}
