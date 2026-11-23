import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { deleteChat, editChat, markChatRead, postChat } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { appendChatMessage, patchProject, replaceChatMessage } from '@/lib/cacheUpdates'
import type { ChatMessage } from '@/lib/types'

export function useSendChat(projectId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { body: string; imageId: number | null }) => postChat(projectId, v.body, v.imageId),
    onSuccess: (msg) => {
      appendChatMessage(qc, projectId, msg)
    },
    onError: (err) => toast.error('Message not sent', { description: errorMessage(err) }),
  })
}

export function useEditChat(projectId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: number; body: string }) => editChat(projectId, v.id, v.body),
    onSuccess: (msg) => replaceChatMessage(qc, projectId, msg),
    onError: (err) => toast.error('Could not edit the message', { description: errorMessage(err) }),
  })
}

export function useDeleteChat(projectId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (msg: ChatMessage) => deleteChat(projectId, msg.id),
    onSuccess: (_res, msg) => {
      replaceChatMessage(qc, projectId, { ...msg, body: '', deleted: true, image: null })
      toast.success('Message deleted')
    },
    onError: (err) => toast.error('Could not delete the message', { description: errorMessage(err) }),
  })
}

/** Mark the project chat read up to `lastId` and clear the unread badge locally. */
export function useMarkChatRead(projectId: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (lastId: number) => markChatRead(projectId, lastId),
    onMutate: () => patchProject(qc, projectId, () => ({ unread_chat: 0 })),
  })
}
