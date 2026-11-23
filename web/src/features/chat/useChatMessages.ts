import { useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { getChat } from '@/lib/endpoints'
import { qk } from '@/lib/queryKeys'
import { CHAT_PAGE_SIZE } from './thread'

/**
 * Project chat history. pages[0] is the newest page; items are ascending inside a page, which is the shape
 * the realtime cache updates (appendChatMessage / replaceChatMessage) expect.
 */
export function useChatMessages(projectId: number) {
  const query = useInfiniteQuery({
    queryKey: qk.chat(projectId),
    queryFn: ({ pageParam, signal }) => getChat(projectId, { before_id: pageParam, limit: CHAT_PAGE_SIZE }, { signal }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.has_more ? last.items[0]?.id : undefined),
    staleTime: 60_000,
  })
  const messages = useMemo(() => (query.data ? [...query.data.pages].reverse().flatMap((p) => p.items) : []), [query.data])
  return { ...query, messages }
}
