import { useEffect, useRef } from 'react'
import { keymap, type ActionId, type ShortcutHandler, type ShortcutScope } from '@/lib/keymap'

interface Options {
  enabled?: boolean
  /** Runs before action matching; return true when the key was consumed. */
  raw?: (e: KeyboardEvent, combo: string | null) => boolean
}

/**
 * Register shortcut handlers for a scope while the component is mounted. Handlers are read from a ref,
 * so they always see fresh state without re-registering.
 */
export function useShortcuts(
  scope: ShortcutScope,
  handlers: Partial<Record<ActionId, ShortcutHandler>>,
  options: Options = {},
): void {
  const handlersRef = useRef(handlers)
  const rawRef = useRef(options.raw)
  const enabledRef = useRef(options.enabled ?? true)
  useEffect(() => {
    handlersRef.current = handlers
    rawRef.current = options.raw
    enabledRef.current = options.enabled ?? true
  })

  const actionKey = Object.keys(handlers).sort().join(',')
  useEffect(() => {
    const proxy: Partial<Record<ActionId, ShortcutHandler>> = {}
    for (const id of actionKey.split(',').filter(Boolean) as ActionId[]) {
      proxy[id] = (e) => handlersRef.current[id]?.(e)
    }
    return keymap.register({
      scope,
      handlers: proxy,
      raw: (e, combo) => rawRef.current?.(e, combo) ?? false,
      enabled: () => enabledRef.current,
    })
  }, [scope, actionKey])
}

/** Attach the global keymap listener once (app root). */
export function useKeymapListener(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      keymap.handleKeyDown(e)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
