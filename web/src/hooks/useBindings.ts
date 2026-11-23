import { useMemo } from 'react'
import { resolveBindings, type Bindings } from '@/lib/keymap'
import { useSettings } from '@/stores/settings'

/** Effective shortcut bindings (defaults + the user's overrides), reactive to settings changes. */
export function useBindings(): Bindings {
  const overrides = useSettings((s) => s.settings.shortcuts)
  return useMemo(() => resolveBindings(overrides), [overrides])
}
