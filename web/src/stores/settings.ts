// User preferences: validated copy of /api/me/settings, optimistic updates, debounced persistence.
import { create } from 'zustand'
import { toast } from 'sonner'
import { putMySettings } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import {
  DEFAULT_SETTINGS,
  applySettingsPatch,
  mergeSettings,
  readStoredTheme,
  serializeSettings,
  storeTheme,
  type UserSettings,
} from '@/lib/settings'

const SAVE_DELAY_MS = 600

interface SettingsState {
  settings: UserSettings
  /** The last object received from the server (unknown keys are preserved on save). */
  raw: Record<string, unknown>
  loaded: boolean
  load: (stored: unknown) => void
  update: (patch: Partial<UserSettings>) => void
  reset: () => void
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingPatch: Partial<UserSettings> | null = null

/** Debounced PUT of the whole (validated) settings object. */
function schedulePut(get: () => SettingsState): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const { settings, raw } = get()
    putMySettings(serializeSettings(settings, raw))
      .then((stored) => useSettings.setState({ raw: stored && typeof stored === 'object' ? stored : raw }))
      .catch((err: unknown) => toast.error('Could not save your preferences', { description: errorMessage(err) }))
  }, SAVE_DELAY_MS)
}

function initialSettings(): UserSettings {
  const theme = readStoredTheme()
  return theme ? { ...DEFAULT_SETTINGS, theme } : { ...DEFAULT_SETTINGS }
}

export const useSettings = create<SettingsState>()((set, get) => ({
  settings: initialSettings(),
  raw: {},
  loaded: false,
  load: (stored) => {
    const raw = stored && typeof stored === 'object' && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {}
    let settings = mergeSettings(raw)
    // Changes made before the server copy arrived are applied on top of it (never over defaults).
    const pending = pendingPatch
    pendingPatch = null
    if (pending) settings = applySettingsPatch(settings, pending)
    storeTheme(settings.theme)
    set({ settings, raw, loaded: true })
    if (pending) schedulePut(get)
  },
  update: (patch) => {
    const settings = applySettingsPatch(get().settings, patch)
    if (patch.theme) storeTheme(settings.theme)
    set({ settings })
    if (!get().loaded) {
      pendingPatch = { ...pendingPatch, ...patch }
      return
    }
    schedulePut(get)
  },
  reset: () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    pendingPatch = null
    set({ settings: initialSettings(), raw: {}, loaded: false })
  },
}))
