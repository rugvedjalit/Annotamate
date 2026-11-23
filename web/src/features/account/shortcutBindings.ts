// Pure helpers for the keyboard shortcuts editor.
import {
  findActionForCombo,
  isReservedCombo,
  resolveBindings,
  type ActionId,
  type Bindings,
} from '@/lib/keymap'

/** Canonical default bindings (no overrides). */
export const DEFAULT_BINDINGS: Bindings = resolveBindings(undefined)

export function isModified(bindings: Bindings, action: ActionId): boolean {
  const a = bindings[action]
  const d = DEFAULT_BINDINGS[action]
  return a.length !== d.length || a.some((c, i) => c !== d[i])
}

export type RecordResult =
  | { kind: 'added'; next: Bindings }
  | { kind: 'unchanged' }
  | { kind: 'reserved'; combo: string }
  | { kind: 'conflict'; combo: string; other: ActionId }

/** Decide what happens when `combo` is recorded for `action`. */
export function recordCombo(bindings: Bindings, action: ActionId, combo: string): RecordResult {
  if (isReservedCombo(combo)) return { kind: 'reserved', combo }
  if (bindings[action].includes(combo)) return { kind: 'unchanged' }
  const other = findActionForCombo(bindings, combo, action)
  if (other) return { kind: 'conflict', combo, other }
  return { kind: 'added', next: { ...bindings, [action]: [...bindings[action], combo] } }
}

/** Move `combo` from `other` to `action`. */
export function replaceCombo(bindings: Bindings, action: ActionId, combo: string, other: ActionId): Bindings {
  return {
    ...bindings,
    [other]: bindings[other].filter((c) => c !== combo),
    [action]: bindings[action].includes(combo) ? bindings[action] : [...bindings[action], combo],
  }
}

export function removeCombo(bindings: Bindings, action: ActionId, combo: string): Bindings {
  return { ...bindings, [action]: bindings[action].filter((c) => c !== combo) }
}

export function resetAction(bindings: Bindings, action: ActionId): Bindings {
  return { ...bindings, [action]: [...DEFAULT_BINDINGS[action]] }
}
