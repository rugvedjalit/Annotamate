import { Fragment } from 'react'
import { comboTokens } from '@/lib/keymap'
import { cn } from '@/lib/utils'

const kbdClass =
  'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-[var(--kbd-line)] bg-[var(--kbd-bg)] px-1 font-mono text-[10.5px] font-semibold leading-none text-[var(--kbd-fg)]'

/** A keyboard combo ("Mod+Shift+V") rendered as key caps, platform-aware. */
export function Kbd({ combo, className }: { combo: string; className?: string }) {
  const tokens = comboTokens(combo)
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)} aria-label={tokens.join(' ')}>
      {tokens.map((t, i) => (
        <kbd key={i} className={kbdClass}>
          {t}
        </kbd>
      ))}
    </span>
  )
}

/** Alternative combos for one action: "Ctrl Y or Ctrl Shift Z" (never run together into one chord). */
export function KbdList({ combos, className }: { combos: readonly string[]; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      {combos.map((c, i) => (
        <Fragment key={c}>
          {i > 0 && <span className="px-0.5 text-2xs text-dim">or</span>}
          <Kbd combo={c} />
        </Fragment>
      ))}
    </span>
  )
}

/** Plain key cap with custom text. */
export function KeyCap({ children, className }: { children: React.ReactNode; className?: string }) {
  return <kbd className={cn(kbdClass, className)}>{children}</kbd>
}
