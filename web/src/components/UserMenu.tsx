import { useNavigate } from 'react-router'
import { Info, Keyboard, LogOut, Monitor, Moon, Settings2, Shield, Sun, UserRound } from 'lucide-react'
import type { ThemePreference } from '@/lib/settings'
import { useSession } from '@/stores/session'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { useSignOut } from '@/hooks/useSignOut'
import { Avatar } from '@/components/ui/Avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { Tooltip } from '@/components/ui/Tooltip'

export function UserMenu() {
  const user = useSession((s) => s.user)
  const theme = useSettings((s) => s.settings.theme)
  const updateSettings = useSettings((s) => s.update)
  const navigate = useNavigate()
  const setShortcutsOpen = useUi((s) => s.setShortcutsOpen)
  const setAboutOpen = useUi((s) => s.setAboutOpen)
  const signOut = useSignOut()
  if (!user) return null

  return (
    <DropdownMenu>
      <Tooltip content="Account">
        <DropdownMenuTrigger
          className="grid size-8 place-items-center rounded-full hover:ring-2 hover:ring-line-strong"
          aria-label={`Account menu for ${user.display_name}`}
        >
          <Avatar user={user} size="sm" tooltip={false} />
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-60">
        <div className="flex items-center gap-2.5 px-2 pb-2 pt-1.5">
          <Avatar user={user} size="md" tooltip={false} />
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{user.display_name}</div>
            <div className="truncate text-xs text-muted">@{user.username}</div>
          </div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<UserRound />} onSelect={() => navigate('/account/profile')}>
          Account
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Settings2 />} onSelect={() => navigate('/account/preferences')}>
          Preferences
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Keyboard />} shortcut="?" onSelect={() => setShortcutsOpen(true)}>
          Keyboard shortcuts
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger icon={theme === 'light' ? <Sun /> : theme === 'dark' ? <Moon /> : <Monitor />}>
            Theme
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => updateSettings({ theme: v as ThemePreference })}>
              <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {user.is_admin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Administration</DropdownMenuLabel>
            <DropdownMenuItem icon={<Shield />} onSelect={() => navigate('/admin/users')}>
              Users
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={<Info />} onSelect={() => setAboutOpen(true)}>
          About Annotamate
        </DropdownMenuItem>
        <DropdownMenuItem icon={<LogOut />} onSelect={() => void signOut()}>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
