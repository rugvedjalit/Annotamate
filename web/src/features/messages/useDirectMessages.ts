import { useMemo } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getDirectMessages, markDirectRead, sendDirectMessage } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { appendDirectMessage, markConversationRead, upsertConversation } from '@/lib/cacheUpdates'
import { qk } from '@/lib/queryKeys'
import type { UserBrief } from '@/lib/types'
import { CHAT_PAGE_SIZE } from '@/features/chat/thread'

/** DM thread with one user. pages[0] = newest page, items ascending (shape used by appendDirectMessage). */
export function useDirectMessages(userId: number) {
  const query = useInfiniteQuery({
    queryKey: qk.dm(userId),
    queryFn: ({ pageParam, signal }) =>
      getDirectMessages(userId, { before_id: pageParam, limit: CHAT_PAGE_SIZE }, { signal }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.has_more ? last.items[0]?.id : undefined),
    staleTime: 60_000,
  })
  const messages = useMemo(() => (query.data ? [...query.data.pages].reverse().flatMap((p) => p.items) : []), [query.data])
  return { ...query, messages }
}

export function useSendDirectMessage(userId: number, other: UserBrief | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: string) => sendDirectMessage(userId, body),
    onSuccess: (msg) => {
      appendDirectMessage(qc, userId, msg)
      if (!upsertConversation(qc, userId, other, msg, false)) void qc.invalidateQueries({ queryKey: qk.conversations })
    },
    onError: (err) => toast.error('Message not sent', { description: errorMessage(err) }),
  })
}

export function useMarkDirectRead(userId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => markDirectRead(userId),
    onMutate: () => markConversationRead(qc, userId),
  })
}
