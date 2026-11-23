import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { ChartNoAxesColumn, Table2 } from 'lucide-react'
import type { DailyStats } from '@/lib/types'
import { formatCompact, formatNumber } from '@/lib/format'
import { IconButton } from '@/components/ui/IconButton'
import { EmptyState } from '@/components/ui/Feedback'
import { useElementWidth } from '../viewHooks'
import { formatDay, niceCountCeil } from './chartUtils'

const HEIGHT = 150
const PAD = { left: 34, right: 10, top: 10, bottom: 22 }
const SERIES = [
  { key: 'saves', label: 'Saves', color: 'var(--accent)' },
  { key: 'done', label: 'Images done', color: 'var(--st-done)' },
] as const

/** Two series (saves, images done) on one shared count axis, with crosshair + tooltip and a table view. */
export function ActivitySparkline({ daily }: { daily: DailyStats[] }) {
  const days = useMemo(() => [...daily].sort((a, b) => a.date.localeCompare(b.date)), [daily])
  if (days.length === 0) {
    return <EmptyState compact icon={<ChartNoAxesColumn />} title="No activity in the last 30 days" />
  }
  return <SparklineBody days={days} />
}

function SparklineBody({ days }: { days: DailyStats[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const width = useElementWidth(ref)
  const [active, setActive] = useState<number | null>(null)
  const [table, setTable] = useState(false)
  const totals = { saves: days.reduce((s, d) => s + d.saves, 0), done: days.reduce((s, d) => s + d.done, 0) }

  const n = days.length
  const plotW = Math.max(width - PAD.left - PAD.right, 1)
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const yMax = niceCountCeil(Math.max(1, ...days.map((d) => Math.max(d.saves, d.done))))
  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const y = (v: number) => PAD.top + plotH - (v / yMax) * plotH
  const path = (key: 'saves' | 'done') => days.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join('')
  const area = n > 1 ? `${path('saves')}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z` : ''

  function onPointerMove(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const i = n <= 1 ? 0 : Math.round(((px - PAD.left) / plotW) * (n - 1))
    setActive(Math.min(Math.max(i, 0), n - 1))
  }

  function onKeyDown(e: KeyboardEvent<SVGSVGElement>) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const cur = active ?? n - 1
      setActive(Math.min(Math.max(cur + (e.key === 'ArrowLeft' ? -1 : 1), 0), n - 1))
    } else if (e.key === 'Home') setActive(0)
    else if (e.key === 'End') setActive(n - 1)
  }

  const legend = (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {SERIES.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5 text-sm">
          <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} aria-hidden />
          <span className="text-muted">{s.label}</span>
          <span className="font-medium tabular-nums text-fg">{formatNumber(totals[s.key])}</span>
        </li>
      ))}
    </ul>
  )

  const point = active !== null ? days[active] : undefined
  const tipLeft = active !== null ? Math.min(Math.max(x(active) - 70, 0), Math.max(width - 140, 0)) : 0

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {legend}
        <IconButton
          className="ml-auto"
          size="sm"
          label={table ? 'Show chart' : 'Show as table'}
          icon={table ? <ChartNoAxesColumn /> : <Table2 />}
          onClick={() => setTable((t) => !t)}
        />
      </div>
      <div ref={ref} className="relative w-full">
        {table ? (
          <div className="max-h-[220px] overflow-y-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-panel-2 text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-1.5 font-medium">Day</th>
                  <th className="px-3 py-1.5 text-right font-medium">Saves</th>
                  <th className="px-3 py-1.5 text-right font-medium">Images done</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line tabular-nums">
                {[...days].reverse().map((d) => (
                  <tr key={d.date}>
                    <td className="px-3 py-1.5 text-fg">{formatDay(d.date, true)}</td>
                    <td className="px-3 py-1.5 text-right text-fg">{formatNumber(d.saves)}</td>
                    <td className="px-3 py-1.5 text-right text-fg">{formatNumber(d.done)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="relative w-full" style={{ height: HEIGHT }}>
            {width > 0 && (
              <svg
                width={width}
                height={HEIGHT}
                role="img"
                tabIndex={0}
                aria-label={`Last ${n} days: ${formatNumber(totals.saves)} saves and ${formatNumber(totals.done)} images done. Use the arrow keys to read each day.`}
                className="block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                onPointerMove={onPointerMove}
                onPointerLeave={() => setActive(null)}
                onKeyDown={onKeyDown}
                onBlur={() => setActive(null)}
                onFocus={() => setActive(n - 1)}
              >
                {[0, yMax / 2, yMax].map((t) => (
                  <g key={t}>
                    <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
                    <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-dim text-[10.5px] tabular-nums">
                      {formatCompact(t)}
                    </text>
                  </g>
                ))}
                <text x={PAD.left} y={HEIGHT - 6} className="fill-dim text-[10.5px]">
                  {formatDay(days[0]!.date)}
                </text>
                <text x={width - PAD.right} y={HEIGHT - 6} textAnchor="end" className="fill-dim text-[10.5px]">
                  {formatDay(days[n - 1]!.date)}
                </text>
                {area && <path d={area} fill="var(--accent)" fillOpacity={0.1} />}
                {SERIES.map((s) => (
                  <path key={s.key} d={path(s.key)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                ))}
                {active !== null && point && (
                  <g pointerEvents="none">
                    <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--line-strong)" strokeWidth={1} />
                    {SERIES.map((s) => (
                      <circle key={s.key} cx={x(active)} cy={y(point[s.key])} r={4} fill={s.color} stroke="var(--panel)" strokeWidth={2} />
                    ))}
                  </g>
                )}
              </svg>
            )}
            {point && (
              <div
                className="pointer-events-none absolute top-0 z-10 w-[140px] animate-fade-in rounded-md border border-line bg-elevated px-2.5 py-1.5 text-xs shadow-pop"
                style={{ left: tipLeft }}
                aria-live="polite"
              >
                <div className="mb-1 text-muted">{formatDay(point.date, true)}</div>
                {SERIES.map((s) => (
                  <div key={s.key} className="flex items-center gap-1.5">
                    <span className="h-0.5 w-2.5 rounded-full" style={{ background: s.color }} aria-hidden />
                    <span className="font-semibold tabular-nums text-fg">{formatNumber(point[s.key])}</span>
                    <span className="text-muted">{s.label.toLowerCase()}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
