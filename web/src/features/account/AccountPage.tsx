import { Navigate, NavLink, useParams } from 'react-router'
import { Keyboard, KeyRound, Settings2, UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMe } from '@/stores/session'
import { Avatar } from '@/components/ui/Avatar'
import { ProfileSection } from './ProfileSection'
import { PasswordSection } from './PasswordSection'
import { PreferencesSection } from './PreferencesSection'
import { ShortcutsEditor } from './ShortcutsEditor'

const TABS = [
  { id: 'profile', label: 'Profile', icon: UserRound },
  { id: 'password', label: 'Password', icon: KeyRound },
  { id: 'preferences', label: 'Preferences', icon: Settings2 },
  { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard },
] as const

type TabId = (typeof TABS)[number]['id']

function isTab(v: string | undefined): v is TabId {
  return TABS.some((t) => t.id === v)
}

/** Account: profile, password, preferences and keyboard shortcuts (tab in the URL). */
export function AccountPage() {
  const me = useMe()
  const { tab } = useParams()
  if (tab !== undefined && !isTab(tab)) return <Navigate to="/account/profile" replace />
  const active: TabId = tab ?? 'profile'

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-8 md:flex-row">
      <aside className="shrink-0 md:w-56">
        <div className="mb-4 flex items-center gap-2.5 px-1">
          <Avatar user={me} size="md" tooltip={false} />
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{me.display_name}</div>
            <div className="truncate text-xs text-muted">Account settings</div>
          </div>
        </div>
        <nav aria-label="Account sections" className="flex gap-1 overflow-x-auto md:flex-col">
          {TABS.map((t) => (
            <NavLink
              key={t.id}
              to={`/account/${t.id}`}
              className={() =>
                cn(
                  'flex h-8 shrink-0 items-center gap-2 rounded-md px-2.5 text-base transition-colors [&_svg]:size-4',
                  active === t.id ? 'bg-hover font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg',
                )
              }
              aria-current={active === t.id ? 'page' : undefined}
            >
              <t.icon aria-hidden />
              {t.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        {active === 'profile' && <ProfileSection />}
        {active === 'password' && <PasswordSection />}
        {active === 'preferences' && <PreferencesSection />}
        {active === 'shortcuts' && <ShortcutsEditor />}
      </div>
    </div>
  )
}
