import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Mail, MessageSquare, Search } from 'lucide-react'
import { useOptionalProjectContext } from '@/app/projectContext'
import { useDmUnread } from '@/hooks/queries'
import { useUi } from '@/stores/ui'
import { useBindings } from '@/hooks/useBindings'
import { cn } from '@/lib/utils'
import { Logo } from '@/components/brand/Logo'
import { CountBadge, IconButton } from '@/components/ui/IconButton'
import { iconButtonVariants } from '@/components/ui/variants'
import { Kbd } from '@/components/ui/Kbd'
import { Tooltip } from '@/components/ui/Tooltip'
import { NotificationsMenu } from './NotificationsMenu'
import { UserMenu } from './UserMenu'

interface TopBarProps {
  /** After the logo (project switcher, tabs). */
  left?: ReactNode
  /** Centred content (image navigator). */
  center?: ReactNode
  /** Before the standard right-side controls (save pill, presence). */
  right?: ReactNode
  className?: string
}

export function TopBar({ left, center, right, className }: TopBarProps) {
  const project = useOptionalProjectContext()
  const chatOpen = useUi((s) => s.chatOpen)
  const toggleChat = useUi((s) => s.toggleChat)
  const setPaletteOpen = useUi((s) => s.setPaletteOpen)
  const dmUnread = useDmUnread()
  const bindings = useBindings()
  const paletteCombo = bindings.palette[0]

  return (
    <header
      className={cn(
        'relative z-20 flex h-12 shrink-0 items-center gap-2.5 whitespace-nowrap border-b border-line bg-panel px-3',
        className,
      )}
    >
      <Link to="/" aria-label="Annotamate home" className="flex shrink-0 items-center rounded-md px-1 py-1">
        <Logo variant="wordmark" height={21} className="hidden lg:block" />
        <Logo variant="mark" height={24} className="lg:hidden" />
      </Link>
      {left && (
        <>
          <div className="h-[22px] w-px shrink-0 bg-line" aria-hidden />
          <div className="flex min-w-0 items-center gap-1">{left}</div>
        </>
      )}
      <div className="flex min-w-0 flex-1 items-center justify-center">{center}</div>
      <div className="flex shrink-0 items-center gap-1.5">
        {right}
        {project && (
          <IconButton
            label={chatOpen ? 'Close project chat' : 'Project chat'}
            shortcut={bindings['chat.toggle']}
            icon={<MessageSquare />}
            active={chatOpen}
            onClick={toggleChat}
            badge={<CountBadge count={chatOpen ? 0 : project.project.unread_chat} />}
          />
        )}
        <Tooltip content="Direct messages">
          <Link
            to="/messages"
            aria-label={dmUnread ? `Direct messages, ${dmUnread} unread` : 'Direct messages'}
            className={cn(iconButtonVariants({ size: 'md' }))}
          >
            <Mail />
            <CountBadge count={dmUnread} />
          </Link>
        </Tooltip>
        <NotificationsMenu />
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="hidden h-[30px] w-44 items-center gap-2 rounded-md border border-line bg-panel-2 pl-2.5 pr-1.5 text-sm text-dim transition-colors hover:border-line-strong hover:text-muted xl:flex"
          aria-label="Open command palette"
        >
          <Search className="size-3.5" aria-hidden />
          <span>Search or run…</span>
          {paletteCombo && <Kbd combo={paletteCombo} className="ml-auto" />}
        </button>
        <IconButton
          className="xl:hidden"
          label="Command palette"
          shortcut={paletteCombo}
          icon={<Search />}
          onClick={() => setPaletteOpen(true)}
        />
        <UserMenu />
      </div>
    </header>
  )
}
