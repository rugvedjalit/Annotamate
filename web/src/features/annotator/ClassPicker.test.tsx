import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ProjectClass } from '@/lib/types'
import { ClassPicker } from './ClassPicker'
import { canCreateClass, filterClasses } from './classPickerLogic'

const classes: ProjectClass[] = [
  { id: 11, index: 0, name: 'person', color: '#f97316' },
  { id: 12, index: 1, name: 'car', color: '#3b82f6' },
  { id: 13, index: 2, name: 'bicycle', color: '#22c55e' },
  { id: 14, index: 3, name: 'truck', color: '#a855f7' },
  { id: 15, index: 4, name: 'traffic light', color: '#ec4899' },
  { id: 16, index: 5, name: 'street sign', color: '#eab308' },
]

describe('filterClasses', () => {
  it('returns every class with 1–9 hotkeys when the query is empty', () => {
    const opts = filterClasses(classes, '  ')
    expect(opts.map((o) => o.cls.id)).toEqual([11, 12, 13, 14, 15, 16])
    expect(opts.map((o) => o.hotkey)).toEqual([1, 2, 3, 4, 5, 6])
    expect(opts.every((o) => o.match === null)).toBe(true)
  })

  it('puts prefix matches first, keeps hotkeys from the full list and marks the match', () => {
    const opts = filterClasses(classes, 'TR')
    expect(opts.map((o) => o.cls.name)).toEqual(['truck', 'traffic light', 'street sign'])
    expect(opts.map((o) => o.hotkey)).toEqual([4, 5, 6])
    expect(opts[2]?.match).toEqual([1, 3])
  })

  it('gives no hotkey beyond the ninth class', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: i, index: i, name: `c${i}`, color: '#000000' }))
    expect(filterClasses(many, '').map((o) => o.hotkey).slice(8)).toEqual([9, null, null, null])
  })
})

describe('canCreateClass', () => {
  it('offers creation only when allowed, non-empty and not an existing name', () => {
    expect(canCreateClass(classes, 'zebra', true)).toBe(true)
    expect(canCreateClass(classes, 'Car', true)).toBe(false)
    expect(canCreateClass(classes, '   ', true)).toBe(false)
    expect(canCreateClass(classes, 'zebra', false)).toBe(false)
  })
})

describe('<ClassPicker />', () => {
  beforeAll(() => {
    // Radix measures its anchor/content with ResizeObserver, which jsdom lacks.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })
  afterEach(() => vi.clearAllMocks())

  function renderPicker(props: Partial<React.ComponentProps<typeof ClassPicker>> = {}) {
    const onPick = vi.fn()
    const onDismiss = vi.fn()
    const onCreate = vi.fn(async (name: string) => ({ id: 99, index: 6, name, color: '#14b8a6' }))
    render(
      <ClassPicker
        anchor={{ x: 100, y: 100 }}
        classes={classes}
        allowCreate
        onPick={onPick}
        onDismiss={onDismiss}
        onCreate={onCreate}
        {...props}
      />,
    )
    return { onPick, onDismiss, onCreate, input: screen.getByRole('combobox', { name: 'Filter classes' }) }
  }

  it('autofocuses the filter and lists every class', async () => {
    const { input } = renderPicker()
    await waitFor(() => expect(input).toHaveFocus())
    expect(screen.getAllByRole('option')).toHaveLength(classes.length)
  })

  it('highlights the initial class and assigns it with Enter', async () => {
    const user = userEvent.setup()
    const { onPick } = renderPicker({ initialClassId: 13 })
    expect(screen.getByRole('option', { name: /bicycle/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Enter}')
    expect(onPick).toHaveBeenCalledWith(13)
  })

  it('filters as you type and moves the highlight with the arrow keys', async () => {
    const user = userEvent.setup()
    const { onPick, input } = renderPicker()
    await user.type(input, 'tr')
    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining('truck'),
      expect.stringContaining('traffic light'),
      expect.stringContaining('street sign'),
      expect.stringContaining('Create class “tr”'),
    ])
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('option', { name: /traffic light/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(screen.getByRole('option', { name: /Create class/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowDown}{Enter}')
    expect(onPick).toHaveBeenCalledWith(14)
  })

  it('picks by number hotkey without typing it into the filter', async () => {
    const user = userEvent.setup()
    const { onPick, input } = renderPicker()
    await user.type(input, '2')
    expect(onPick).toHaveBeenCalledWith(12)
    expect(input).toHaveValue('')
  })

  it('creates a class with Enter when nothing matches', async () => {
    const user = userEvent.setup()
    const { onPick, onCreate, input } = renderPicker()
    await user.type(input, 'zebra{Enter}')
    await waitFor(() => expect(onPick).toHaveBeenCalledWith(99))
    expect(onCreate).toHaveBeenCalledWith('zebra')
  })

  it('does not offer creation without permission', async () => {
    const user = userEvent.setup()
    const { input } = renderPicker({ allowCreate: false })
    await user.type(input, 'zebra')
    expect(screen.queryByRole('option', { name: /Create class/ })).not.toBeInTheDocument()
    expect(screen.getByText('No matching class')).toBeInTheDocument()
  })

  it('Escape dismisses (the new box is discarded by the caller)', async () => {
    const user = userEvent.setup()
    const { onDismiss, onPick } = renderPicker()
    await user.keyboard('{Escape}')
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('clicking an option assigns it', async () => {
    const user = userEvent.setup()
    const { onPick } = renderPicker()
    await user.click(screen.getByRole('option', { name: /person/ }))
    expect(onPick).toHaveBeenCalledWith(11)
  })
})
