import { useMemo } from 'react'
import { useNavigate } from 'react-router'
import { Command } from 'cmdk'
import { Dialog as D } from 'radix-ui'
import {
  Bell,
  Database,
  Info,
  Keyboard,
  LayoutGrid,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Monitor,
  Moon,
  PenTool,
  Search,
  Settings2,
  Shield,
  Sun,
  Table,
  UserRound,
} from 'lucide-react'
import { useProjects } from '@/hooks/queries'
import { useSession } from '@/stores/session'
import { useSettings } from '@/stores/settings'
import { useUi, type PaletteCommand } from '@/stores/ui'
import { FormatBadge } from '@/components/ui/Badge'
import { Kbd } from '@/components/ui/Kbd'
import { useSignOut } from '@/hooks/useSignOut'

/** Mod+K: navigate anywhere and run any registered action. */
export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen)
  const setOpen = useUi((s) => s.setPaletteOpen)
  const registered = useUi((s) => s.commands)
  const currentProjectId = useUi((s) => s.currentProjectId)
  const toggleChat = useUi((s) => s.toggleChat)
  const setShortcutsOpen = useUi((s) => s.setShortcutsOpen)
  const setAboutOpen = useUi((s) => s.setAboutOpen)
  const user = useSession((s) => s.user)
  const updateSettings = useSettings((s) => s.update)
  const navigate = useNavigate()
  const signOut = useSignOut()
  const { data: projects } = useProjects(false)

  const groups = useMemo(() => {
    const go = (path: string) => () => navigate(path)
    const list: PaletteCommand[] = []
    for (const cmds of Object.values(registered)) list.push(...cmds)

    if (currentProjectId !== null) {
      const p = `/p/${currentProjectId}`
      list.push(
        { id: 'proj.overview', group: 'This project', label: 'Project overview', icon: <LayoutGrid />, run: go(p) },
        { id: 'proj.annotate', group: 'This project', label: 'Continue annotating', icon: <PenTool />, run: go(`${p}/annotate`) },
        { id: 'proj.images', group: 'This project', label: 'Images table', icon: <Table />, run: go(`${p}/images`) },
        {
          id: 'proj.review',
          group: 'This project',
          label: 'Review queue',
          icon: <Search />,
          run: go(`${p}/annotate?status=review`),
        },
        { id: 'proj.chat', group: 'This project', label: 'Toggle project chat', icon: <MessageSquare />, run: toggleChat },
        { id: 'proj.settings', group: 'This project', label: 'Project settings', icon: <Settings2 />, run: go(`${p}/settings`) },
      )
    }

    list.push(
      { id: 'nav.home', group: 'Go to', label: 'All projects', icon: <LayoutGrid />, run: go('/') },
      { id: 'nav.messages', group: 'Go to', label: 'Direct messages', icon: <MessagesSquare />, run: go('/messages') },
      { id: 'nav.notifications', group: 'Go to', label: 'Notifications', icon: <Bell />, run: go('/notifications') },
      { id: 'nav.account', group: 'Go to', label: 'Account', icon: <UserRound />, run: go('/account/profile') },
      { id: 'nav.prefs', group: 'Go to', label: 'Preferences', icon: <Settings2 />, run: go('/account/preferences') },
      {
        id: 'nav.shortcuts',
        group: 'Go to',
        label: 'Customize keyboard shortcuts',
        icon: <Keyboard />,
        run: go('/account/shortcuts'),
      },
    )
    if (user?.is_admin) {
      list.push({ id: 'nav.users', group: 'Go to', label: 'Manage users', icon: <Shield />, run: go('/admin/users') })
    }

    list.push(
      { id: 'theme.dark', group: 'Theme', label: 'Dark theme', icon: <Moon />, run: () => updateSettings({ theme: 'dark' }) },
      { id: 'theme.light', group: 'Theme', label: 'Light theme', icon: <Sun />, run: () => updateSettings({ theme: 'light' }) },
      {
        id: 'theme.system',
        group: 'Theme',
        label: 'Use system theme',
        icon: <Monitor />,
        run: () => updateSettings({ theme: 'system' }),
      },
      { id: 'help.shortcuts', group: 'Help', label: 'Keyboard shortcuts', icon: <Keyboard />, shortcut: ['?'], run: () => setShortcutsOpen(true) },
      { id: 'help.about', group: 'Help', label: 'About Annotamate', icon: <Info />, run: () => setAboutOpen(true) },
      { id: 'session.signout', group: 'Help', label: 'Sign out', icon: <LogOut />, run: () => void signOut() },
    )

    const byGroup = new Map<string, PaletteCommand[]>()
    for (const c of list) {
      const g = byGroup.get(c.group)
      if (g) g.push(c)
      else byGroup.set(c.group, [c])
    }
    return [...byGroup.entries()]
  }, [registered, currentProjectId, user, navigate, toggleChat, updateSettings, setShortcutsOpen, setAboutOpen, signOut])

  function run(cmd: () => void) {
    setOpen(false)
    // Let the dialog close (and return focus) before the command moves focus elsewhere.
    requestAnimationFrame(cmd)
  }

  return (
    <D.Root open={open} onOpenChange={setOpen}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-[65] animate-fade-in bg-overlay" />
        <D.Content
          aria-label="Command palette"
          className="fixed left-1/2 top-[14vh] z-[65] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 animate-pop-in overflow-hidden rounded-xl border border-line bg-elevated shadow-pop focus:outline-none"
        >
          <D.Title className="sr-only">Command palette</D.Title>
          <D.Description className="sr-only">Search for pages, projects and actions</D.Description>
          <Command loop className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-line px-3.5">
              <Search className="size-4 text-dim" aria-hidden />
              <Command.Input
                autoFocus
                placeholder="Search pages, projects and actions…"
                className="h-12 flex-1 bg-transparent text-md text-fg placeholder:text-dim focus:outline-none"
              />
              <Kbd combo="Escape" />
            </div>
            <Command.List className="max-h-[min(440px,60vh)] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-8 text-center text-sm text-muted">No matching commands.</Command.Empty>
              {groups.map(([group, cmds]) => (
                <Command.Group
                  key={group}
                  heading={group}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-dim"
                >
                  {cmds.map((c) => (
                    <Command.Item
                      key={c.id}
                      value={`${c.group} ${c.label} ${c.keywords?.join(' ') ?? ''}`}
                      disabled={c.disabled}
                      onSelect={() => run(c.run)}
                      className="flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-base text-fg data-[disabled=true]:pointer-events-none data-[selected=true]:bg-hover data-[disabled=true]:opacity-45 [&_svg]:size-4 [&_svg]:text-muted"
                    >
                      {c.icon}
                      <span className="flex-1 truncate">{c.label}</span>
                      {c.shortcut?.[0] && <Kbd combo={c.shortcut[0]} />}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
              {projects && projects.length > 0 && (
                <Command.Group
                  heading="Projects"
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-dim"
                >
                  {projects.map((p) => (
                    <Command.Item
                      key={p.id}
                      value={`project ${p.name} ${p.id}`}
                      onSelect={() => run(() => navigate(`/p/${p.id}`))}
                      className="flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-base text-fg data-[selected=true]:bg-hover [&_svg]:size-4 [&_svg]:text-muted"
                    >
                      <Database />
                      <span className="flex-1 truncate">{p.name}</span>
                      <FormatBadge format={p.label_format} />
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
