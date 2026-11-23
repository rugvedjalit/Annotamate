import { Link } from 'react-router'
import { ACTIONS, SHORTCUT_GROUPS } from '@/lib/keymap'
import { useBindings } from '@/hooks/useBindings'
import { useUi } from '@/stores/ui'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { Kbd, KbdList, KeyCap } from '@/components/ui/Kbd'
import { Button } from '@/components/ui/Button'

/** "?" — every action with its current bindings. */
export function ShortcutsDialog() {
  const open = useUi((s) => s.shortcutsOpen)
  const setOpen = useUi((s) => s.setShortcutsOpen)
  const bindings = useBindings()

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        size="xl"
        title="Keyboard shortcuts"
        description="Mod is Ctrl on Windows and Linux, ⌘ on macOS. All shortcuts can be changed in your account."
        footer={
          <Button asChild variant="secondary" onClick={() => setOpen(false)}>
            <Link to="/account/shortcuts">Customize shortcuts</Link>
          </Button>
        }
      >
        <div className="grid gap-x-8 gap-y-5 md:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group}>
              <h3 className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-dim">{group}</h3>
              <ul className="divide-y divide-line/60">
                {ACTIONS.filter((a) => a.group === group && !/^class\.[2-9]$/.test(a.id)).map((a) => (
                  <li key={a.id} className="flex h-8 items-center justify-between gap-4 text-base">
                    <span className="truncate text-fg">{a.id === 'class.1' ? 'Class 1–9 (set active / assign)' : a.label}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {a.id === 'class.1' ? (
                        <>
                          <KeyCap>1</KeyCap>–<KeyCap>9</KeyCap>
                        </>
                      ) : bindings[a.id].length === 0 ? (
                        <span className="text-xs text-dim">Not set</span>
                      ) : (
                        <KbdList combos={bindings[a.id]} />
                      )}
                    </span>
                  </li>
                ))}
                {group === 'Tools' && (
                  <li className="flex h-8 items-center justify-between gap-4 text-base">
                    <span className="text-fg">Pan while held</span>
                    <Kbd combo="Space" />
                  </li>
                )}
                {group === 'Editing' && (
                  <li className="flex h-8 items-center justify-between gap-4 text-base">
                    <span className="text-fg">Nudge selection 1 px (Shift: 10 px)</span>
                    <span className="flex gap-1">
                      <Kbd combo="ArrowLeft" />
                      <Kbd combo="ArrowUp" />
                      <Kbd combo="ArrowDown" />
                      <Kbd combo="ArrowRight" />
                    </span>
                  </li>
                )}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
