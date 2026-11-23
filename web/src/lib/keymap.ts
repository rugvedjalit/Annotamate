// One keymap service for the whole app: action definitions, combo parsing ("Mod+Shift+V"), event matching,
// conflict detection, reserved combos and scoped dispatch.
import { IS_MAC } from './config'

export const ACTION_IDS = [
  'tool.select',
  'tool.box',
  'tool.pan',
  'view.fit',
  'view.actual',
  'view.labels',
  'view.crosshair',
  'view.panels',
  'class.pick',
  'class.prev',
  'class.next',
  'class.1',
  'class.2',
  'class.3',
  'class.4',
  'class.5',
  'class.6',
  'class.7',
  'class.8',
  'class.9',
  'select.all',
  'select.none',
  'select.cycle',
  'image.prev',
  'image.next',
  'image.submit',
  'image.flag',
  'save',
  'undo',
  'redo',
  'box.delete',
  'box.duplicate',
  'box.copy',
  'box.paste',
  'box.pastePrevious',
  'palette',
  'help',
  'chat.toggle',
] as const

export type ActionId = (typeof ACTION_IDS)[number]
export type ShortcutScope = 'global' | 'annotator'
export type ShortcutGroup = 'Tools' | 'View' | 'Classes' | 'Selection' | 'Images' | 'Editing' | 'General'

export interface ActionDef {
  id: ActionId
  label: string
  group: ShortcutGroup
  scope: ShortcutScope
  /** Also fires while focus is in a text field (only Mod combos are sensible here). */
  allowInInputs?: boolean
}

const CLASS_ACTIONS: ActionDef[] = Array.from({ length: 9 }, (_, i) => ({
  id: `class.${i + 1}` as ActionId,
  label: `Class ${i + 1} (set active / assign to selection)`,
  group: 'Classes' as const,
  scope: 'annotator' as const,
}))

export const ACTIONS: readonly ActionDef[] = [
  { id: 'tool.select', label: 'Select tool', group: 'Tools', scope: 'annotator' },
  { id: 'tool.box', label: 'Box tool', group: 'Tools', scope: 'annotator' },
  { id: 'tool.pan', label: 'Pan tool (hold Space to pan temporarily)', group: 'Tools', scope: 'annotator' },
  { id: 'view.fit', label: 'Zoom to fit', group: 'View', scope: 'annotator' },
  { id: 'view.actual', label: 'Actual size (1:1)', group: 'View', scope: 'annotator' },
  { id: 'view.labels', label: 'Toggle labels', group: 'View', scope: 'annotator' },
  { id: 'view.crosshair', label: 'Toggle crosshair', group: 'View', scope: 'annotator' },
  { id: 'view.panels', label: 'Toggle side panels', group: 'View', scope: 'annotator' },
  { id: 'class.pick', label: 'Pick class for selection', group: 'Classes', scope: 'annotator' },
  { id: 'class.prev', label: 'Previous class', group: 'Classes', scope: 'annotator' },
  { id: 'class.next', label: 'Next class', group: 'Classes', scope: 'annotator' },
  ...CLASS_ACTIONS,
  { id: 'select.all', label: 'Select all boxes', group: 'Selection', scope: 'annotator' },
  { id: 'select.none', label: 'Clear selection', group: 'Selection', scope: 'annotator' },
  { id: 'select.cycle', label: 'Select next box', group: 'Selection', scope: 'annotator' },
  { id: 'image.prev', label: 'Previous image', group: 'Images', scope: 'annotator' },
  { id: 'image.next', label: 'Next image', group: 'Images', scope: 'annotator' },
  { id: 'image.submit', label: 'Submit image', group: 'Images', scope: 'annotator' },
  { id: 'image.flag', label: 'Flag / unflag image', group: 'Images', scope: 'annotator' },
  { id: 'save', label: 'Save now', group: 'Editing', scope: 'annotator' },
  { id: 'undo', label: 'Undo', group: 'Editing', scope: 'annotator' },
  { id: 'redo', label: 'Redo', group: 'Editing', scope: 'annotator' },
  { id: 'box.delete', label: 'Delete selected boxes', group: 'Editing', scope: 'annotator' },
  { id: 'box.duplicate', label: 'Duplicate selected boxes', group: 'Editing', scope: 'annotator' },
  { id: 'box.copy', label: 'Copy selected boxes', group: 'Editing', scope: 'annotator' },
  { id: 'box.paste', label: 'Paste boxes', group: 'Editing', scope: 'annotator' },
  { id: 'box.pastePrevious', label: "Paste previous image's boxes", group: 'Editing', scope: 'annotator' },
  { id: 'palette', label: 'Command palette', group: 'General', scope: 'global', allowInInputs: true },
  { id: 'help', label: 'Keyboard shortcuts', group: 'General', scope: 'global' },
  { id: 'chat.toggle', label: 'Toggle project chat', group: 'General', scope: 'global' },
]

export const ACTION_MAP: Record<ActionId, ActionDef> = Object.fromEntries(ACTIONS.map((a) => [a.id, a])) as Record<
  ActionId,
  ActionDef
>

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  'Tools',
  'View',
  'Classes',
  'Selection',
  'Images',
  'Editing',
  'General',
]

export const DEFAULT_SHORTCUTS: Readonly<Record<ActionId, readonly string[]>> = {
  'tool.select': ['V'],
  'tool.box': ['W'],
  'tool.pan': ['H'],
  'view.fit': ['F'],
  'view.actual': ['0'],
  'view.labels': ['L'],
  'view.crosshair': ['C'],
  'view.panels': ['\\'],
  'class.pick': ['X'],
  'class.prev': ['Q'],
  'class.next': ['E'],
  'class.1': ['1'],
  'class.2': ['2'],
  'class.3': ['3'],
  'class.4': ['4'],
  'class.5': ['5'],
  'class.6': ['6'],
  'class.7': ['7'],
  'class.8': ['8'],
  'class.9': ['9'],
  'select.all': ['Mod+A'],
  'select.none': ['Escape'],
  'select.cycle': ['Tab'],
  'image.prev': ['A', 'ArrowLeft'],
  'image.next': ['D', 'ArrowRight'],
  'image.submit': ['Mod+Enter'],
  'image.flag': ['G'],
  save: ['Mod+S'],
  undo: ['Mod+Z'],
  redo: ['Mod+Y', 'Mod+Shift+Z'],
  'box.delete': ['Delete', 'Backspace'],
  'box.duplicate': ['Mod+D'],
  'box.copy': ['Mod+C'],
  'box.paste': ['Mod+V'],
  'box.pastePrevious': ['Mod+Shift+V'],
  palette: ['Mod+K'],
  help: ['?'],
  'chat.toggle': ['Mod+/'],
}

export function isActionId(value: string): value is ActionId {
  return (ACTION_IDS as readonly string[]).includes(value)
}

// ------------------------------------------------------------------------------------------------
// Combo parsing and formatting
// ------------------------------------------------------------------------------------------------

const MODIFIER_ORDER = ['Mod', 'Ctrl', 'Alt', 'Shift', 'Meta'] as const
type Modifier = (typeof MODIFIER_ORDER)[number]

const MODIFIER_ALIASES: Record<string, Modifier> = {
  mod: 'Mod',
  cmd: 'Mod',
  command: 'Mod',
  '⌘': 'Mod',
  ctrl: 'Ctrl',
  control: 'Ctrl',
  '⌃': 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  '⌥': 'Alt',
  shift: 'Shift',
  '⇧': 'Shift',
  meta: 'Meta',
  win: 'Meta',
  super: 'Meta',
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape',
  escape: 'Escape',
  del: 'Delete',
  delete: 'Delete',
  backspace: 'Backspace',
  return: 'Enter',
  enter: 'Enter',
  space: 'Space',
  spacebar: 'Space',
  ' ': 'Space',
  tab: 'Tab',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
  plus: '+',
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS', 'Hyper', 'Super', 'Fn'])

/** Single printable character that is not a letter or digit ("?", "/", "\\", "["). Shift is implied by these. */
function isSymbolKey(key: string): boolean {
  return key.length === 1 && !/[a-z0-9]/i.test(key)
}

function normalizeKeyToken(token: string): string | null {
  if (!token) return null
  const alias = KEY_ALIASES[token.toLowerCase()]
  if (alias) return alias
  if (token.length === 1) return /[a-z]/i.test(token) ? token.toUpperCase() : token
  const f = /^f(\d{1,2})$/i.exec(token)
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 24) return `F${Number(f[1])}`
  return null
}

function buildCombo(mods: Set<Modifier>, key: string): string {
  if (isSymbolKey(key)) mods.delete('Shift')
  const parts: string[] = MODIFIER_ORDER.filter((m) => mods.has(m))
  parts.push(key)
  return parts.join('+')
}

/**
 * Parse a user/config string ("ctrl+shift+v", "Mod+K", "?") into the canonical form
 * ("Mod+Shift+V"). On non-Mac platforms Ctrl and Mod are the same key. Returns null if invalid.
 */
export function parseCombo(input: string, isMac = IS_MAC): string | null {
  const raw = input.trim()
  if (!raw) return null
  let tokens: string[]
  if (raw === '+') tokens = ['+']
  else if (raw.endsWith('++')) tokens = [...raw.slice(0, -2).split('+'), '+']
  else tokens = raw.split('+')
  tokens = tokens.map((t) => (t === '+' ? t : t.trim()))
  const keyToken = tokens.pop()
  if (keyToken === undefined) return null
  const mods = new Set<Modifier>()
  for (const t of tokens) {
    const m = MODIFIER_ALIASES[t.toLowerCase()]
    if (!m) return null
    mods.add(!isMac && m === 'Ctrl' ? 'Mod' : m)
  }
  const key = normalizeKeyToken(keyToken)
  if (!key) return null
  return buildCombo(mods, key)
}

/** Key name of a keyboard event, layout-tolerant for letters and digits. Null for modifier-only presses. */
export function eventKey(e: Pick<KeyboardEvent, 'key' | 'code'>): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const code = e.code ?? ''
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code)
  if (digit) return digit[1]!
  if (e.key && e.key.length === 1 && /[a-z]/i.test(e.key)) return e.key.toUpperCase()
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter && (e.key.length !== 1 || !/[ -~]/.test(e.key))) return letter[1]!
  if (e.key === ' ' || code === 'Space') return 'Space'
  if (e.key === 'Dead' || e.key === 'Unidentified' || !e.key) return letter ? letter[1]! : null
  return normalizeKeyToken(e.key)
}

type ComboEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

/** Canonical combo for a keyboard event, or null for bare modifier presses. */
export function eventToCombo(e: ComboEvent, isMac = IS_MAC): string | null {
  const key = eventKey(e)
  if (!key) return null
  const mods = new Set<Modifier>()
  if (isMac) {
    if (e.metaKey) mods.add('Mod')
    if (e.ctrlKey) mods.add('Ctrl')
  } else {
    if (e.ctrlKey) mods.add('Mod')
    if (e.metaKey) mods.add('Meta')
  }
  if (e.altKey) mods.add('Alt')
  if (e.shiftKey) mods.add('Shift')
  return buildCombo(mods, key)
}

export function matchesCombo(e: ComboEvent, combo: string, isMac = IS_MAC): boolean {
  const c = eventToCombo(e, isMac)
  return c !== null && c === parseCombo(combo, isMac)
}

const KEY_LABELS: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  Delete: 'Del',
  Backspace: '⌫',
  Enter: '↵',
  Space: 'Space',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
}

/** Display tokens for a combo, e.g. ["Ctrl", "Shift", "V"] or ["⌘", "⇧", "V"]. */
export function comboTokens(combo: string, isMac = IS_MAC): string[] {
  const canonical = parseCombo(combo, isMac) ?? combo
  const parts = canonical === '+' ? ['+'] : canonical.endsWith('++') ? [...canonical.slice(0, -2).split('+'), '+'] : canonical.split('+')
  return parts.map((p) => {
    switch (p) {
      case 'Mod':
        return isMac ? '⌘' : 'Ctrl'
      case 'Ctrl':
        return isMac ? '⌃' : 'Ctrl'
      case 'Alt':
        return isMac ? '⌥' : 'Alt'
      case 'Shift':
        return isMac ? '⇧' : 'Shift'
      case 'Meta':
        return 'Win'
      default:
        return KEY_LABELS[p] ?? p
    }
  })
}

export function formatCombo(combo: string, isMac = IS_MAC): string {
  return comboTokens(combo, isMac).join(isMac ? '' : '+')
}

// ------------------------------------------------------------------------------------------------
// Reserved combos, bindings, conflicts
// ------------------------------------------------------------------------------------------------

const RESERVED_RAW = [
  'Mod+W',
  'Mod+T',
  'Mod+N',
  'Mod+Tab',
  'Mod+Shift+Tab',
  'Mod+Shift+T',
  'Mod+Shift+N',
  'Mod+Shift+W',
  'Mod+Q',
  'Mod+R',
  'F5',
  'Mod+F5',
  'F11',
  'F12',
  'Alt+F4',
  'Alt+Tab',
]

export function isReservedCombo(combo: string, isMac = IS_MAC): boolean {
  const c = parseCombo(combo, isMac)
  if (!c) return false
  return RESERVED_RAW.some((r) => parseCombo(r, isMac) === c)
}

export type Bindings = Record<ActionId, string[]>
export type ShortcutOverrides = Partial<Record<ActionId, string[]>>

/** Validate a list of combos: canonicalise, drop invalid/reserved, de-duplicate. */
export function sanitizeCombos(list: unknown, isMac = IS_MAC): string[] | null {
  if (!Array.isArray(list)) return null
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const c = parseCombo(item, isMac)
    if (c && !isReservedCombo(c, isMac) && !out.includes(c)) out.push(c)
  }
  return out
}

/** Defaults with user overrides applied. An override of [] means "unbound". */
export function resolveBindings(overrides: ShortcutOverrides | undefined, isMac = IS_MAC): Bindings {
  const out = {} as Bindings
  for (const id of ACTION_IDS) {
    const o = overrides?.[id]
    let list = o !== undefined ? sanitizeCombos(o, isMac) : null
    // An explicit [] means "unbound"; a list whose combos are all invalid falls back to the defaults.
    if (list && list.length === 0 && Array.isArray(o) && o.length > 0) list = null
    out[id] = list ?? DEFAULT_SHORTCUTS[id].map((c) => parseCombo(c, isMac) ?? c)
  }
  return out
}

/** Only the actions whose bindings differ from the defaults. */
export function computeOverrides(bindings: Bindings, isMac = IS_MAC): ShortcutOverrides {
  const out: ShortcutOverrides = {}
  for (const id of ACTION_IDS) {
    const def = DEFAULT_SHORTCUTS[id].map((c) => parseCombo(c, isMac) ?? c)
    const cur = bindings[id]
    if (cur.length !== def.length || cur.some((c, i) => c !== def[i])) out[id] = [...cur]
  }
  return out
}

/** Combos bound to more than one action. */
export function findConflicts(bindings: Bindings): Map<string, ActionId[]> {
  const byCombo = new Map<string, ActionId[]>()
  for (const id of ACTION_IDS) {
    for (const combo of bindings[id]) {
      const list = byCombo.get(combo)
      if (list) list.push(id)
      else byCombo.set(combo, [id])
    }
  }
  for (const [combo, ids] of byCombo) if (ids.length < 2) byCombo.delete(combo)
  return byCombo
}

/** Which other action already uses this combo (for the shortcut editor). */
export function findActionForCombo(bindings: Bindings, combo: string, except?: ActionId): ActionId | null {
  for (const id of ACTION_IDS) {
    if (id !== except && bindings[id].includes(combo)) return id
  }
  return null
}

// ------------------------------------------------------------------------------------------------
// Dispatch
// ------------------------------------------------------------------------------------------------

/** True for inputs, textareas, selects and contenteditable elements. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
  }
  return false
}

/**
 * Inside an open dialog, menu, popover or select: those own the keyboard (Radix handles focus and keys).
 * In-page listboxes (file list, objects list) are not overlays; they stop the keys they handle themselves.
 */
function isInsideOverlay(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[data-radix-popper-content-wrapper],[cmdk-root]')
  )
}

/** Return false to let the next registration (or the browser) handle the key. */
export type ShortcutHandler = (e: KeyboardEvent) => boolean | void

export interface ShortcutRegistration {
  scope: ShortcutScope
  handlers: Partial<Record<ActionId, ShortcutHandler>>
  /** Runs before action matching (e.g. arrow nudging). Return true when consumed. */
  raw?: (e: KeyboardEvent, combo: string | null) => boolean
  enabled?: () => boolean
}

export class KeymapService {
  private bindings: Bindings
  private index = new Map<string, ActionId[]>()
  private registrations: ShortcutRegistration[] = []
  private readonly isMac: boolean

  constructor(isMac = IS_MAC) {
    this.isMac = isMac
    this.bindings = resolveBindings(undefined, isMac)
    this.rebuildIndex()
  }

  setBindings(bindings: Bindings): void {
    this.bindings = bindings
    this.rebuildIndex()
  }

  getBindings(): Bindings {
    return this.bindings
  }

  combosFor(action: ActionId): string[] {
    return this.bindings[action]
  }

  /** Registrations added later take precedence (inner scopes register after outer ones). */
  register(reg: ShortcutRegistration): () => void {
    this.registrations.push(reg)
    return () => {
      this.registrations = this.registrations.filter((r) => r !== reg)
    }
  }

  private rebuildIndex(): void {
    this.index.clear()
    for (const id of ACTION_IDS) {
      for (const combo of this.bindings[id]) {
        const list = this.index.get(combo)
        if (list) list.push(id)
        else this.index.set(combo, [id])
      }
    }
  }

  /** Returns true when the event was handled. */
  handleKeyDown = (e: KeyboardEvent): boolean => {
    if (e.defaultPrevented || e.isComposing) return false
    const combo = eventToCombo(e, this.isMac)
    const editable = isEditableTarget(e.target)
    const overlay = isInsideOverlay(e.target)
    const actions = combo ? (this.index.get(combo) ?? []) : []

    for (let i = this.registrations.length - 1; i >= 0; i--) {
      const reg = this.registrations[i]!
      if (reg.enabled && !reg.enabled()) continue
      if (!editable && !overlay && reg.raw?.(e, combo)) {
        e.preventDefault()
        return true
      }
      for (const action of actions) {
        const handler = reg.handlers[action]
        if (!handler) continue
        const def = ACTION_MAP[action]
        const isEscape = combo === 'Escape'
        if (overlay && !def.allowInInputs) continue
        if (editable && !def.allowInInputs && !isEscape) continue
        if (handler(e) === false) continue
        e.preventDefault()
        return true
      }
    }
    return false
  }
}

export const keymap = new KeymapService()
