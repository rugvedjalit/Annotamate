// UI state: resolved theme, panel visibility, drawers and dialogs, command registry for the palette.
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { ReactNode } from 'react'
import type { ImageRef } from '@/lib/types'

export interface PaletteCommand {
  id: string
  label: string
  group: string
  icon?: ReactNode
  /** Combo(s) shown as a hint, e.g. ["Mod+S"]. */
  shortcut?: readonly string[]
  keywords?: string[]
  disabled?: boolean
  run: () => void
}

interface UiState {
  resolvedTheme: 'dark' | 'light'
  setResolvedTheme: (t: 'dark' | 'light') => void

  chatOpen: boolean
  setChatOpen: (open: boolean) => void
  toggleChat: () => void

  paletteOpen: boolean
  setPaletteOpen: (open: boolean) => void
  shortcutsOpen: boolean
  setShortcutsOpen: (open: boolean) => void
  aboutOpen: boolean
  setAboutOpen: (open: boolean) => void

  filesPanelOpen: boolean
  inspectorOpen: boolean
  setFilesPanelOpen: (open: boolean) => void
  setInspectorOpen: (open: boolean) => void
  togglePanels: () => void

  /** Project of the current route (null outside projects). */
  currentProjectId: number | null
  setCurrentProjectId: (pid: number | null) => void
  /** Image open in the annotator (for "share current image" in chat). */
  currentImage: ImageRef | null
  setCurrentImage: (image: ImageRef | null) => void
  /** DM conversation on screen (suppresses toasts for it). */
  activeDmUserId: number | null
  setActiveDmUserId: (id: number | null) => void

  commands: Record<string, PaletteCommand[]>
  setCommands: (owner: string, commands: PaletteCommand[] | null) => void
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      resolvedTheme: 'dark',
      setResolvedTheme: (resolvedTheme) => set({ resolvedTheme }),

      chatOpen: false,
      setChatOpen: (chatOpen) => set({ chatOpen }),
      toggleChat: () => set((s) => ({ chatOpen: !s.chatOpen })),

      paletteOpen: false,
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      shortcutsOpen: false,
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
      aboutOpen: false,
      setAboutOpen: (aboutOpen) => set({ aboutOpen }),

      filesPanelOpen: true,
      inspectorOpen: true,
      setFilesPanelOpen: (filesPanelOpen) => set({ filesPanelOpen }),
      setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
      togglePanels: () =>
        set((s) => {
          const anyOpen = s.filesPanelOpen || s.inspectorOpen
          return { filesPanelOpen: !anyOpen, inspectorOpen: !anyOpen }
        }),

      currentProjectId: null,
      setCurrentProjectId: (currentProjectId) => set({ currentProjectId }),
      currentImage: null,
      setCurrentImage: (currentImage) => set({ currentImage }),
      activeDmUserId: null,
      setActiveDmUserId: (activeDmUserId) => set({ activeDmUserId }),

      commands: {},
      setCommands: (owner, commands) =>
        set((s) => {
          const next = { ...s.commands }
          if (commands) next[owner] = commands
          else delete next[owner]
          return { commands: next }
        }),
    }),
    {
      name: 'annotamate.ui',
      version: 1,
      partialize: (s) => ({ filesPanelOpen: s.filesPanelOpen, inspectorOpen: s.inspectorOpen }),
    },
  ),
)
