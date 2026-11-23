import { useState } from 'react'
import { Download } from 'lucide-react'
import { exportUrl } from '@/lib/endpoints'
import type { LabelFormat } from '@/lib/types'
import { LABEL_FORMATS } from '@/lib/types'
import { FORMAT_DESCRIPTIONS, FORMAT_LABELS } from '@/lib/status'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { CheckboxField } from '@/components/ui/Checkbox'

/** Export as a zip (plain GET download, cookie-authenticated). */
export function ExportPopover({ projectId, defaultFormat }: { projectId: number; defaultFormat: LabelFormat }) {
  const [format, setFormat] = useState<LabelFormat>(defaultFormat)
  const [scope, setScope] = useState<'all' | 'done'>('all')
  const [withImages, setWithImages] = useState(false)
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="secondary">
          <Download />
          Export
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col gap-3.5 p-4">
        <div>
          <div className="text-base font-semibold">Export labels</div>
          <div className="text-xs text-muted">Downloads a zip archive of the project.</div>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Format</span>
          <Select
            aria-label="Export format"
            value={format}
            onValueChange={setFormat}
            items={LABEL_FORMATS.map((f) => ({ value: f, label: FORMAT_LABELS[f], description: FORMAT_DESCRIPTIONS[f] }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Images</span>
          <SegmentedControl
            aria-label="Export scope"
            value={scope}
            onValueChange={setScope}
            options={[
              { value: 'all', label: 'All images' },
              { value: 'done', label: 'Done only' },
            ]}
          />
        </div>
        <CheckboxField label="Include the image files" checked={withImages} onCheckedChange={setWithImages} />
        <Button asChild variant="primary" onClick={() => setOpen(false)}>
          <a href={exportUrl(projectId, format, scope, withImages)} download>
            <Download />
            Download zip
          </a>
        </Button>
      </PopoverContent>
    </Popover>
  )
}
