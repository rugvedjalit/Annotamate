import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACTION_IDS,
  ACTIONS,
  DEFAULT_SHORTCUTS,
  KeymapService,
  comboTokens,
  computeOverrides,
  eventToCombo,
  findActionForCombo,
  findConflicts,
  formatCombo,
  isEditableTarget,
  isReservedCombo,
  matchesCombo,
  parseCombo,
  resolveBindings,
  sanitizeCombos,
  type ShortcutOverrides,
} from './keymap'

type KeyInit = Pick<KeyboardEventInit, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

function ev(init: KeyInit) {
  return {
    key: init.key ?? '',
    code: init.code ?? '',
    ctrlKey: !!init.ctrlKey,
    metaKey: !!init.metaKey,
    altKey: !!init.altKey,
    shiftKey: !!init.shiftKey,
  }
}

describe('parseCombo', () => {
  it('canonicalises case, modifier order and aliases', () => {
    expect(parseCombo('mod+k', false)).toBe('Mod+K')
    expect(parseCombo('Shift+Alt+Mod+x', false)).toBe('Mod+Alt+Shift+X')
    expect(parseCombo('cmd+shift+v', false)).toBe('Mod+Shift+V')
    expect(parseCombo('option+a', true)).toBe('Alt+A')
    expect(parseCombo('esc', false)).toBe('Escape')
    expect(parseCombo('Del', false)).toBe('Delete')
    expect(parseCombo('return', false)).toBe('Enter')
    expect(parseCombo('left', false)).toBe('ArrowLeft')
    expect(parseCombo('space', false)).toBe('Space')
    expect(parseCombo('  Mod + K  ', false)).toBe('Mod+K')
  })

  it('treats Ctrl as Mod on non-Mac platforms only', () => {
    expect(parseCombo('ctrl+shift+v', false)).toBe('Mod+Shift+V')
    expect(parseCombo('ctrl+shift+v', true)).toBe('Ctrl+Shift+V')
    expect(parseCombo('Ctrl+Mod+A', true)).toBe('Mod+Ctrl+A')
    expect(parseCombo('Meta+A', false)).toBe('Meta+A')
  })

  it('drops Shift for symbol keys but keeps it for letters and digits', () => {
    expect(parseCombo('?', false)).toBe('?')
    expect(parseCombo('Shift+?', false)).toBe('?')
    expect(parseCombo('Mod+/', false)).toBe('Mod+/')
    expect(parseCombo('\\', false)).toBe('\\')
    expect(parseCombo('Shift+A', false)).toBe('Shift+A')
    expect(parseCombo('Mod+Shift+1', false)).toBe('Mod+Shift+1')
  })

  it('handles the plus key and function keys', () => {
    expect(parseCombo('+', false)).toBe('+')
    expect(parseCombo('Mod++', false)).toBe('Mod++')
    expect(parseCombo('plus', false)).toBe('+')
    expect(parseCombo('f5', false)).toBe('F5')
    expect(parseCombo('Shift+F12', false)).toBe('Shift+F12')
    expect(parseCombo('F24', false)).toBe('F24')
    expect(parseCombo('F25', false)).toBeNull()
    expect(parseCombo('F0', false)).toBeNull()
  })

  it('returns null for invalid input', () => {
    expect(parseCombo('', false)).toBeNull()
    expect(parseCombo('   ', false)).toBeNull()
    expect(parseCombo('Foo+A', false)).toBeNull()
    expect(parseCombo('Mod+', false)).toBeNull()
    expect(parseCombo('Shift', false)).toBeNull()
    expect(parseCombo('Mod+Shift', false)).toBeNull()
    expect(parseCombo('PrintScreenX', false)).toBeNull()
  })
})

describe('eventToCombo', () => {
  it('maps Ctrl to Mod on non-Mac and Meta to Mod on Mac', () => {
    expect(eventToCombo(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), false)).toBe('Mod+K')
    expect(eventToCombo(ev({ key: 'k', code: 'KeyK', metaKey: true }), false)).toBe('Meta+K')
    expect(eventToCombo(ev({ key: 'k', code: 'KeyK', metaKey: true }), true)).toBe('Mod+K')
    expect(eventToCombo(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), true)).toBe('Ctrl+K')
  })

  it('reads letters from key, falling back to code for non-Latin layouts and Alt characters', () => {
    expect(eventToCombo(ev({ key: 'a', code: 'KeyA' }), false)).toBe('A')
    expect(eventToCombo(ev({ key: 'A', code: 'KeyA', shiftKey: true }), false)).toBe('Shift+A')
    // AZERTY: the key labelled "A" sits on KeyQ — the produced character wins.
    expect(eventToCombo(ev({ key: 'a', code: 'KeyQ' }), false)).toBe('A')
    // Cyrillic layout: "ф" on KeyA.
    expect(eventToCombo(ev({ key: 'ф', code: 'KeyA' }), false)).toBe('A')
    // macOS Option+A produces "å".
    expect(eventToCombo(ev({ key: 'å', code: 'KeyA', altKey: true }), true)).toBe('Alt+A')
    // Dead keys fall back to the physical key.
    expect(eventToCombo(ev({ key: 'Dead', code: 'KeyE' }), false)).toBe('E')
  })

  it('reads digits from Digit/Numpad codes so Shift+1 is not "!"', () => {
    expect(eventToCombo(ev({ key: '1', code: 'Digit1' }), false)).toBe('1')
    expect(eventToCombo(ev({ key: '!', code: 'Digit1', shiftKey: true }), false)).toBe('Shift+1')
    expect(eventToCombo(ev({ key: '7', code: 'Numpad7' }), false)).toBe('7')
  })

  it('handles Space, symbols and named keys', () => {
    expect(eventToCombo(ev({ key: ' ', code: 'Space' }), false)).toBe('Space')
    expect(eventToCombo(ev({ key: '?', code: 'Slash', shiftKey: true }), false)).toBe('?')
    expect(eventToCombo(ev({ key: '/', code: 'Slash', ctrlKey: true }), false)).toBe('Mod+/')
    expect(eventToCombo(ev({ key: '\\', code: 'Backslash' }), false)).toBe('\\')
    expect(eventToCombo(ev({ key: 'ArrowLeft', code: 'ArrowLeft', shiftKey: true }), false)).toBe('Shift+ArrowLeft')
    expect(eventToCombo(ev({ key: 'Enter', code: 'Enter', ctrlKey: true }), false)).toBe('Mod+Enter')
    expect(eventToCombo(ev({ key: 'Escape', code: 'Escape' }), false)).toBe('Escape')
    expect(eventToCombo(ev({ key: 'Delete', code: 'Delete' }), false)).toBe('Delete')
    expect(eventToCombo(ev({ key: 'Tab', code: 'Tab' }), false)).toBe('Tab')
    expect(eventToCombo(ev({ key: 'F5', code: 'F5' }), false)).toBe('F5')
  })

  it('returns null for bare modifiers and unidentifiable keys', () => {
    expect(eventToCombo(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), false)).toBeNull()
    expect(eventToCombo(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), false)).toBeNull()
    expect(eventToCombo(ev({ key: 'Meta', code: 'MetaLeft', metaKey: true }), true)).toBeNull()
    expect(eventToCombo(ev({ key: 'Unidentified', code: '' }), false)).toBeNull()
  })
})

describe('matchesCombo / comboTokens / formatCombo', () => {
  it('matches events against user-written combos', () => {
    expect(matchesCombo(ev({ key: 'z', code: 'KeyZ', ctrlKey: true }), 'ctrl+z', false)).toBe(true)
    expect(matchesCombo(ev({ key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true }), 'Mod+Z', false)).toBe(false)
    expect(matchesCombo(ev({ key: 'z', code: 'KeyZ', metaKey: true }), 'Mod+Z', true)).toBe(true)
    expect(matchesCombo(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), 'Shift', false)).toBe(false)
  })

  it('formats platform-aware tokens', () => {
    expect(comboTokens('Mod+Shift+V', false)).toEqual(['Ctrl', 'Shift', 'V'])
    expect(comboTokens('Mod+Shift+V', true)).toEqual(['⌘', '⇧', 'V'])
    expect(comboTokens('Alt+ArrowLeft', true)).toEqual(['⌥', '←'])
    expect(comboTokens('Ctrl+A', true)).toEqual(['⌃', 'A'])
    expect(comboTokens('Meta+A', false)).toEqual(['Win', 'A'])
    expect(comboTokens('Escape', false)).toEqual(['Esc'])
    expect(comboTokens('Mod++', false)).toEqual(['Ctrl', '+'])
    expect(comboTokens('?', false)).toEqual(['?'])
    expect(formatCombo('Mod+Shift+V', false)).toBe('Ctrl+Shift+V')
    expect(formatCombo('Mod+Shift+V', true)).toBe('⌘⇧V')
    expect(formatCombo('Delete', false)).toBe('Del')
    expect(formatCombo('Backspace', false)).toBe('⌫')
  })
})

describe('reserved combos and sanitising', () => {
  it('rejects browser-reserved combos', () => {
    for (const c of ['Mod+W', 'ctrl+w', 'Mod+T', 'Mod+N', 'Mod+Tab', 'Mod+Shift+T', 'F5']) {
      expect(isReservedCombo(c, false), c).toBe(true)
    }
    expect(isReservedCombo('Mod+W', true)).toBe(true)
    expect(isReservedCombo('Ctrl+W', true)).toBe(false)
    expect(isReservedCombo('Mod+K', false)).toBe(false)
    expect(isReservedCombo('Shift+F5', false)).toBe(false)
    expect(isReservedCombo('nonsense+', false)).toBe(false)
  })

  it('sanitizeCombos canonicalises, drops invalid/reserved and de-duplicates', () => {
    expect(sanitizeCombos(['mod+k', 'Mod+K', 'mod+w', 'bogus+x', 5, 'A', null], false)).toEqual(['Mod+K', 'A'])
    expect(sanitizeCombos([], false)).toEqual([])
    expect(sanitizeCombos('Mod+K', false)).toBeNull()
    expect(sanitizeCombos(undefined, false)).toBeNull()
  })
})

describe('bindings', () => {
  it('resolves to canonical defaults without overrides', () => {
    const b = resolveBindings(undefined, false)
    expect(Object.keys(b).sort()).toEqual([...ACTION_IDS].sort())
    expect(b['tool.box']).toEqual(['W'])
    expect(b.redo).toEqual(['Mod+Y', 'Mod+Shift+Z'])
    expect(b['image.prev']).toEqual(['A', 'ArrowLeft'])
    expect(b['view.panels']).toEqual(['\\'])
    expect(b.help).toEqual(['?'])
    expect(b['box.pastePrevious']).toEqual(['Mod+Shift+V'])
  })

  it('applies overrides; [] means unbound; invalid and reserved entries are dropped', () => {
    const overrides: ShortcutOverrides = { undo: ['mod+u', 'Mod+W', 'nope+1'], redo: [], 'tool.box': ['B'] }
    const b = resolveBindings(overrides, false)
    expect(b.undo).toEqual(['Mod+U'])
    expect(b.redo).toEqual([])
    expect(b['tool.box']).toEqual(['B'])
    expect(b['tool.select']).toEqual(['V'])
  })

  it('ignores malformed override values', () => {
    const overrides = { undo: 'Mod+U' } as unknown as ShortcutOverrides
    expect(resolveBindings(overrides, false).undo).toEqual(['Mod+Z'])
  })

  it('computeOverrides keeps only changed actions and round-trips', () => {
    expect(computeOverrides(resolveBindings(undefined, false), false)).toEqual({})
    const b = resolveBindings(undefined, false)
    b.undo = ['Mod+U']
    b.redo = ['Mod+Shift+Z', 'Mod+Y'] // order change counts as a change
    b['tool.pan'] = []
    const o = computeOverrides(b, false)
    expect(o).toEqual({ undo: ['Mod+U'], redo: ['Mod+Shift+Z', 'Mod+Y'], 'tool.pan': [] })
    expect(resolveBindings(o, false)).toEqual(b)
  })

  it('default bindings have no conflicts', () => {
    expect(findConflicts(resolveBindings(undefined, false)).size).toBe(0)
    expect(findConflicts(resolveBindings(undefined, true)).size).toBe(0)
  })

  it('findConflicts reports combos used by several actions', () => {
    const b = resolveBindings({ 'tool.box': ['A'] }, false)
    const conflicts = findConflicts(b)
    expect([...conflicts.keys()]).toEqual(['A'])
    expect(conflicts.get('A')).toEqual(['tool.box', 'image.prev'])
  })

  it('findActionForCombo finds the owner, optionally excluding one action', () => {
    const b = resolveBindings(undefined, false)
    expect(findActionForCombo(b, 'W')).toBe('tool.box')
    expect(findActionForCombo(b, 'W', 'tool.box')).toBeNull()
    expect(findActionForCombo(b, 'Mod+J')).toBeNull()
  })

  it('every action has a definition and every default parses', () => {
    expect(ACTIONS.map((a) => a.id).sort()).toEqual([...ACTION_IDS].sort())
    for (const id of ACTION_IDS) {
      for (const combo of DEFAULT_SHORTCUTS[id]) {
        expect(parseCombo(combo, false), `${id}: ${combo}`).not.toBeNull()
        expect(isReservedCombo(combo, false), `${id}: ${combo}`).toBe(false)
      }
    }
  })
})

describe('isEditableTarget', () => {
  it('detects text fields but not buttons or checkboxes', () => {
    const text = document.createElement('input')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    const range = document.createElement('input')
    range.type = 'range'
    const number = document.createElement('input')
    number.type = 'number'
    expect(isEditableTarget(text)).toBe(true)
    expect(isEditableTarget(number)).toBe(true)
    expect(isEditableTarget(checkbox)).toBe(false)
    expect(isEditableTarget(range)).toBe(false)
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true)
    expect(isEditableTarget(document.createElement('select'))).toBe(true)
    expect(isEditableTarget(document.createElement('button'))).toBe(false)
    expect(isEditableTarget(document.createElement('div'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(window)).toBe(false)
  })

  it('detects contenteditable elements', () => {
    const div = document.createElement('div')
    Object.defineProperty(div, 'isContentEditable', { value: true })
    expect(isEditableTarget(div)).toBe(true)
  })
})

describe('KeymapService dispatch', () => {
  const cleanup: (() => void)[] = []
  afterEach(() => {
    while (cleanup.length) cleanup.pop()!()
    document.body.innerHTML = ''
  })

  function mount<T extends HTMLElement>(el: T): T {
    document.body.appendChild(el)
    return el
  }

  /** Dispatch a real keydown on `target` and route it through the service. */
  function press(service: KeymapService, init: KeyInit & { isComposing?: boolean }, target: HTMLElement = document.body, prevent = false) {
    const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
    let handled = false
    const listener = (e: Event) => {
      if (prevent) e.preventDefault()
      handled = service.handleKeyDown(e as KeyboardEvent)
    }
    target.addEventListener('keydown', listener, { once: true })
    target.dispatchEvent(event)
    return { handled, event }
  }

  function reg(service: KeymapService, ...args: Parameters<KeymapService['register']>) {
    const off = service.register(...args)
    cleanup.push(off)
    return off
  }

  it('runs the matching handler and prevents the default action', () => {
    const svc = new KeymapService(false)
    const box = vi.fn()
    reg(svc, { scope: 'annotator', handlers: { 'tool.box': box } })
    const { handled, event } = press(svc, { key: 'w', code: 'KeyW' })
    expect(handled).toBe(true)
    expect(box).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('ignores unbound keys', () => {
    const svc = new KeymapService(false)
    const box = vi.fn()
    reg(svc, { scope: 'annotator', handlers: { 'tool.box': box } })
    const { handled, event } = press(svc, { key: 'j', code: 'KeyJ' })
    expect(handled).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(box).not.toHaveBeenCalled()
  })

  it('ignores keys typed in text fields, except Escape', () => {
    const svc = new KeymapService(false)
    const box = vi.fn()
    const none = vi.fn()
    reg(svc, { scope: 'annotator', handlers: { 'tool.box': box, 'select.none': none } })
    const input = mount(document.createElement('input'))
    expect(press(svc, { key: 'w', code: 'KeyW' }, input).handled).toBe(false)
    expect(box).not.toHaveBeenCalled()
    expect(press(svc, { key: 'Escape', code: 'Escape' }, input).handled).toBe(true)
    expect(none).toHaveBeenCalledTimes(1)
  })

  it('lets allowInInputs actions (palette) fire inside text fields and dialogs', () => {
    const svc = new KeymapService(false)
    const palette = vi.fn()
    reg(svc, { scope: 'global', handlers: { palette } })
    const textarea = mount(document.createElement('textarea'))
    expect(press(svc, { key: 'k', code: 'KeyK', ctrlKey: true }, textarea).handled).toBe(true)
    const dialog = mount(document.createElement('div'))
    dialog.setAttribute('role', 'dialog')
    const button = dialog.appendChild(document.createElement('button'))
    expect(press(svc, { key: 'k', code: 'KeyK', ctrlKey: true }, button).handled).toBe(true)
    expect(palette).toHaveBeenCalledTimes(2)
  })

  it('ignores events inside open dialogs and menus (they own the keyboard)', () => {
    const svc = new KeymapService(false)
    const box = vi.fn()
    const none = vi.fn()
    const raw = vi.fn(() => true)
    reg(svc, { scope: 'annotator', handlers: { 'tool.box': box, 'select.none': none }, raw })
    for (const role of ['dialog', 'alertdialog', 'menu']) {
      const overlay = mount(document.createElement('div'))
      overlay.setAttribute('role', role)
      const inner = overlay.appendChild(document.createElement('button'))
      expect(press(svc, { key: 'w', code: 'KeyW' }, inner).handled, role).toBe(false)
      expect(press(svc, { key: 'Escape', code: 'Escape' }, inner).handled, role).toBe(false)
    }
    // Popovers/selects rendered by Radix live in a popper wrapper.
    const popper = mount(document.createElement('div'))
    popper.setAttribute('data-radix-popper-content-wrapper', '')
    const option = popper.appendChild(document.createElement('div'))
    option.setAttribute('role', 'listbox')
    expect(press(svc, { key: 'w', code: 'KeyW' }, option).handled).toBe(false)
    expect(box).not.toHaveBeenCalled()
    expect(none).not.toHaveBeenCalled()
    expect(raw).not.toHaveBeenCalled()
  })

  it('handles keys from in-page listboxes (file and object lists are not overlays)', () => {
    const svc = new KeymapService(false)
    const box = vi.fn()
    reg(svc, { scope: 'annotator', handlers: { 'tool.box': box } })
    const list = mount(document.createElement('div'))
    list.setAttribute('role', 'listbox')
    list.tabIndex = 0
    expect(press(svc, { key: 'w', code: 'KeyW' }, list).handled).toBe(true)
    expect(box).toHaveBeenCalledTimes(1)
  })

  it('falls through to the previous registration when a handler returns false', () => {
    const svc = new KeymapService(false)
    const outer = vi.fn()
    const inner = vi.fn(() => false)
    reg(svc, { scope: 'global', handlers: { undo: outer } })
    reg(svc, { scope: 'annotator', handlers: { undo: inner } })
    expect(press(svc, { key: 'z', code: 'KeyZ', ctrlKey: true }).handled).toBe(true)
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).toHaveBeenCalledTimes(1)
  })

  it('does not prevent the default when every handler declines', () => {
    const svc = new KeymapService(false)
    reg(svc, { scope: 'annotator', handlers: { undo: () => false } })
    const { handled, event } = press(svc, { key: 'z', code: 'KeyZ', ctrlKey: true })
    expect(handled).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })

  it('gives the latest registration precedence', () => {
    const svc = new KeymapService(false)
    const first = vi.fn()
    const second = vi.fn()
    reg(svc, { scope: 'annotator', handlers: { undo: first } })
    reg(svc, { scope: 'annotator', handlers: { undo: second } })
    press(svc, { key: 'z', code: 'KeyZ', ctrlKey: true })
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('consults the raw handler before matching actions', () => {
    const svc = new KeymapService(false)
    const prev = vi.fn()
    const raw = vi.fn((_e: KeyboardEvent, combo: string | null) => combo === 'ArrowLeft' || combo === 'ArrowUp')
    reg(svc, { scope: 'annotator', handlers: { 'image.prev': prev }, raw })
    const up = press(svc, { key: 'ArrowUp', code: 'ArrowUp' })
    expect(up.handled).toBe(true)
    expect(up.event.defaultPrevented).toBe(true)
    press(svc, { key: 'ArrowLeft', code: 'ArrowLeft' })
    expect(prev).not.toHaveBeenCalled()
    press(svc, { key: 'a', code: 'KeyA' })
    expect(prev).toHaveBeenCalledTimes(1)
    expect(raw).toHaveBeenCalledWith(expect.any(KeyboardEvent), 'ArrowUp')
  })

  it('does not call raw handlers for keys typed in text fields', () => {
    const svc = new KeymapService(false)
    const raw = vi.fn(() => true)
    reg(svc, { scope: 'annotator', handlers: {}, raw })
    const input = mount(document.createElement('input'))
    expect(press(svc, { key: 'ArrowUp', code: 'ArrowUp' }, input).handled).toBe(false)
    expect(raw).not.toHaveBeenCalled()
  })

  it('skips disabled registrations', () => {
    const svc = new KeymapService(false)
    const outer = vi.fn()
    const inner = vi.fn()
    let enabled = false
    reg(svc, { scope: 'global', handlers: { undo: outer } })
    reg(svc, { scope: 'annotator', handlers: { undo: inner }, enabled: () => enabled })
    press(svc, { key: 'z', code: 'KeyZ', ctrlKey: true })
    expect(inner).not.toHaveBeenCalled()
    expect(outer).toHaveBeenCalledTimes(1)
    enabled = true
    press(svc, { key: 'z', code: 'KeyZ', ctrlKey: true })
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('stops calling handlers after unregister', () => {
    const svc = new KeymapService(false)
    const undo = vi.fn()
    const off = reg(svc, { scope: 'annotator', handlers: { undo } })
    off()
    expect(press(svc, { key: 'z', code: 'KeyZ', ctrlKey: true }).handled).toBe(false)
    expect(undo).not.toHaveBeenCalled()
  })

  it('uses new bindings after setBindings', () => {
    const svc = new KeymapService(false)
    const box = vi.fn()
    reg(svc, { scope: 'annotator', handlers: { 'tool.box': box } })
    svc.setBindings(resolveBindings({ 'tool.box': ['B'] }, false))
    expect(svc.combosFor('tool.box')).toEqual(['B'])
    expect(svc.getBindings()['tool.box']).toEqual(['B'])
    press(svc, { key: 'w', code: 'KeyW' })
    expect(box).not.toHaveBeenCalled()
    press(svc, { key: 'b', code: 'KeyB' })
    expect(box).toHaveBeenCalledTimes(1)
  })

  it('ignores events that were already handled or are part of IME composition', () => {
    const svc = new KeymapService(false)
    const box = vi.fn()
    reg(svc, { scope: 'annotator', handlers: { 'tool.box': box } })
    expect(press(svc, { key: 'w', code: 'KeyW' }, document.body, true).handled).toBe(false)
    expect(press(svc, { key: 'w', code: 'KeyW', isComposing: true }).handled).toBe(false)
    expect(box).not.toHaveBeenCalled()
  })

  it('uses ⌘ as Mod on macOS', () => {
    const svc = new KeymapService(true)
    const undo = vi.fn()
    reg(svc, { scope: 'annotator', handlers: { undo } })
    press(svc, { key: 'z', code: 'KeyZ', ctrlKey: true })
    expect(undo).not.toHaveBeenCalled()
    press(svc, { key: 'z', code: 'KeyZ', metaKey: true })
    expect(undo).toHaveBeenCalledTimes(1)
  })

  it('dispatches each bound combo of a multi-binding action', () => {
    const svc = new KeymapService(false)
    const redo = vi.fn()
    reg(svc, { scope: 'annotator', handlers: { redo } })
    press(svc, { key: 'y', code: 'KeyY', ctrlKey: true })
    press(svc, { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true })
    expect(redo).toHaveBeenCalledTimes(2)
  })
})
