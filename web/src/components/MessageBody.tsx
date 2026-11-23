import { useMemo } from 'react'
import { tokenizeMessage } from '@/lib/mentions'
import { cn } from '@/lib/utils'
import { useSession } from '@/stores/session'

interface MessageBodyProps {
  body: string
  /** Known usernames; unknown @words render as plain text. */
  usernames?: ReadonlySet<string>
  className?: string
}

/** Renders text with @mentions and links highlighted. Never injects HTML. */
export function MessageBody({ body, usernames, className }: MessageBodyProps) {
  const me = useSession((s) => s.user?.username)
  const tokens = useMemo(() => tokenizeMessage(body), [body])
  return (
    <div className={cn('whitespace-pre-wrap break-words text-base leading-5 text-fg', className)}>
      {tokens.map((t, i) => {
        if (t.type === 'link') {
          return (
            <a
              key={i}
              href={t.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent-text underline decoration-accent-text/40 underline-offset-2 hover:decoration-accent-text"
            >
              {t.value}
            </a>
          )
        }
        if (t.type === 'mention' && (!usernames || usernames.has(t.username))) {
          const self = t.username === me
          return (
            <span
              key={i}
              className={cn(
                'rounded px-0.5 font-medium',
                self ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-accent-text',
              )}
            >
              {t.value}
            </span>
          )
        }
        return <span key={i}>{t.value}</span>
      })}
    </div>
  )
}
