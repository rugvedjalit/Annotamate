import { useEffect, type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { keymap } from '@/lib/keymap'
import { applyThemeClass, resolveTheme } from '@/lib/settings'
import { useBindings } from '@/hooks/useBindings'
import { useSettings } from '@/stores/settings'
import { useUi } from '@/stores/ui'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { queryClient } from './queryClient'

/** Applies the theme preference (incl. "system" changes) and mirrors it into the UI store. */
function ThemeController() {
  const pref = useSettings((s) => s.settings.theme)
  const setResolved = useUi((s) => s.setResolvedTheme)
  useEffect(() => {
    const apply = () => {
      const t = resolveTheme(pref)
      applyThemeClass(t)
      setResolved(t)
    }
    apply()
    if (pref !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [pref, setResolved])
  return null
}

/** Keeps the keymap service in sync with the user's shortcut overrides. */
function KeymapSync() {
  const bindings = useBindings()
  useEffect(() => keymap.setBindings(bindings), [bindings])
  return null
}

function ThemedToaster() {
  const theme = useUi((s) => s.resolvedTheme)
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      closeButton
      visibleToasts={4}
      toastOptions={{
        classNames: {
          toast: '!bg-elevated !border-line !text-fg !shadow-pop !rounded-lg !text-base',
          description: '!text-muted !text-sm',
          actionButton: '!bg-accent !text-accent-fg',
          cancelButton: '!bg-hover !text-fg',
        },
      }}
    />
  )
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={450} skipDelayDuration={150}>
        <ThemeController />
        <KeymapSync />
        {children}
        <ThemedToaster />
      </TooltipProvider>
    </QueryClientProvider>
  )
}
