// Shared styles for DropdownMenu and ContextMenu.
export const menuContentClass =
  'z-[60] min-w-44 animate-pop-in overflow-hidden rounded-lg border border-line bg-elevated p-1 text-fg shadow-pop focus:outline-none'

export const menuItemClass =
  'relative flex h-8 cursor-pointer select-none items-center gap-2 rounded-md px-2 text-base outline-none transition-colors data-[disabled]:pointer-events-none data-[highlighted]:bg-hover data-[disabled]:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted'

export const menuDangerClass = 'text-danger data-[highlighted]:bg-danger-soft [&_svg]:text-danger'

export const menuLabelClass = 'px-2 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-dim'

export const menuSeparatorClass = 'my-1 h-px bg-line'
