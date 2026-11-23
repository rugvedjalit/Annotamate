import type { ReactNode } from 'react'
import { CREDIT_LINE } from '@/lib/config'
import { Logo } from '@/components/brand/Logo'

/** Centred card with the wordmark, used by the sign-in and first-run setup pages. */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="relative flex min-h-full flex-col items-center justify-center overflow-hidden bg-bg px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(600px_300px_at_50%_-60px,var(--accent-soft),transparent_70%),radial-gradient(420px_260px_at_85%_110%,rgba(242,138,46,0.07),transparent_70%)]"
      />
      <main className="relative w-full max-w-[400px]">
        <div className="mb-7 flex justify-center">
          <Logo variant="wordmark" height={40} />
        </div>
        <div className="rounded-xl border border-line bg-panel p-7 shadow-pop">
          <h1 className="text-lg font-semibold tracking-tight text-fg">{title}</h1>
          {subtitle && <p className="mt-1 text-pretty text-base text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </main>
      <footer className="relative mt-8 text-xs text-muted">{CREDIT_LINE}</footer>
    </div>
  )
}
