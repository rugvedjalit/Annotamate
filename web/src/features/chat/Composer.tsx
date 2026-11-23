import { useRef, useState } from 'react'
import { ImageIcon, SendHorizontal, X } from 'lucide-react'
import type { UserBrief } from '@/lib/types'
import { cn } from '@/lib/utils'
import { realtime } from '@/stores/realtime'
import { useUi } from '@/stores/ui'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'
import { MentionTextarea } from '@/components/MentionTextarea'
import { shouldSendTyping } from './thread'
import { useSendChat } from './useChatActions'

interface ComposerProps {
  projectId: number
  members: readonly UserBrief[]
}

/** Project chat composer: @mentions, Enter to send, optional "share current image" attachment. */
export function Composer({ projectId, members }: ComposerProps) {
  const [body, setBody] = useState('')
  const [shareImage, setShareImage] = useState(false)
  const currentImage = useUi((s) => s.currentImage)
  const send = useSendChat(projectId)
  const lastTyping = useRef(0)
  const attach = shareImage && currentImage ? currentImage : null

  function submit() {
    const text = body.trim()
    if (!text || send.isPending) return
    // Clear right away (the message usually arrives over the socket before the POST resolves); restore the
    // draft if sending fails and the user has not started a new one.
    const hadImage = shareImage
    setBody('')
    setShareImage(false)
    send.mutate(
      { body: text, imageId: attach?.id ?? null },
      {
        onError: () => {
          setBody((current) => (current.trim() ? current : text))
          setShareImage(hadImage)
        },
      },
    )
  }

  function onTyping() {
    const now = Date.now()
    if (shouldSendTyping(lastTyping.current, now)) {
      lastTyping.current = now
      realtime.sendTyping('chat')
    }
  }

  return (
    <div className="border-t border-line bg-panel px-3 pb-3 pt-2">
      {currentImage && (
        <div className="mb-2 flex items-center gap-1.5">
          {attach ? (
            <span className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-md border border-accent/40 bg-accent-soft pl-2 pr-0.5 text-xs text-accent-text">
              <ImageIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate font-mono">{attach.filename}</span>
              <button
                type="button"
                onClick={() => setShareImage(false)}
                aria-label="Remove image attachment"
                className="grid size-5 place-items-center rounded hover:bg-accent-soft"
              >
                <X className="size-3" />
              </button>
            </span>
          ) : (
            <Tooltip content="Attach a link to the image you are viewing">
              <button
                type="button"
                onClick={() => setShareImage(true)}
                className="inline-flex h-6 items-center gap-1.5 rounded-md border border-dashed border-line-strong px-2 text-xs text-muted hover:border-accent hover:text-accent-text"
              >
                <ImageIcon className="size-3.5" aria-hidden />
                Share current image
              </button>
            </Tooltip>
          )}
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <div className="min-w-0 flex-1">
          <MentionTextarea
            value={body}
            onChange={setBody}
            onSubmit={submit}
            users={members}
            onTyping={onTyping}
            autoFocus
            maxRows={6}
            placeholder="Message the team… (@ to mention)"
            aria-label="Chat message"
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
  )
}
