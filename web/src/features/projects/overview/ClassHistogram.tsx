import { useState } from 'react'
import { Tag } from 'lucide-react'
import type { ProjectClass, ProjectStats } from '@/lib/types'
import { formatNumber, formatPercent } from '@/lib/format'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/Feedback'
import { Tooltip } from '@/components/ui/Tooltip'

const TOP = 10

/**
 * Boxes per class as horizontal bars (8px, rounded data end, square at the baseline). Class colours mark
 * identity; names and values stay in text colours. Values are printed at the bar tip.
 */
export function ClassHistogram({ classes, stats }: { classes: ProjectClass[]; stats: ProjectStats }) {
  const [showAll, setShowAll] = useState(false)
  const byId = new Map(stats.class_counts.map((c) => [c.class_id, c]))
  const rows = classes
    .map((c) => ({ cls: c, boxes: byId.get(c.id)?.boxes ?? 0, images: byId.get(c.id)?.images ?? 0 }))
    .sort((a, b) => b.boxes - a.boxes || a.cls.index - b.cls.index)
  const max = Math.max(1, ...rows.map((r) => r.boxes))
  const totalBoxes = rows.reduce((s, r) => s + r.boxes, 0)
  const shown = showAll ? rows : rows.slice(0, TOP)

  if (classes.length === 0) {
    return <EmptyState compact icon={<Tag />} title="No classes yet" description="Classes appear here once they are added to the project." />
  }

  return (
    <div className="flex flex-col gap-1">
      <ul className="flex flex-col">
        {shown.map(({ cls, boxes, images }) => (
          <li key={cls.id}>
            <Tooltip
              side="top"
              delayDuration={150}
              content={
                <span>
                  <span className="font-semibold">{formatNumber(boxes)}</span>{' '}
                  <span className="text-muted">
                    boxes in {formatNumber(images)} images · {formatPercent(boxes, totalBoxes, 1)} of all boxes
                  </span>
                </span>
              }
            >
              <div
                tabIndex={0}
                className="grid grid-cols-[minmax(90px,170px)_1fr] items-center gap-3 rounded-md px-1.5 py-1 outline-none hover:bg-hover focus-visible:bg-hover"
                aria-label={`${cls.name}: ${formatNumber(boxes)} boxes in ${formatNumber(images)} images`}
              >
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ background: cls.color }} aria-hidden />
                  <span className="truncate text-fg">{cls.name}</span>
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-2 min-w-0 flex-1">
                    <span
                      className="block h-full rounded-r-[4px]"
                      style={{ width: boxes > 0 ? `max(2px, ${(boxes / max) * 100}%)` : 0, background: cls.color }}
                    />
                  </span>
                  <span className="w-28 shrink-0 text-right text-xs tabular-nums text-muted">
                    <span className="font-medium text-fg">{formatNumber(boxes)}</span> · {formatNumber(images)} img
                  </span>
                </span>
              </div>
            </Tooltip>
          </li>
        ))}
      </ul>
      {rows.length > TOP && (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show top 10' : `Show all ${rows.length} classes`}
        </Button>
      )}
    </div>
  )
}
