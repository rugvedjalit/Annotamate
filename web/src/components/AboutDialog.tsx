import { useUi } from '@/stores/ui'
import { useMeta } from '@/hooks/queries'
import { CREDIT_LINE } from '@/lib/config'
import { Dialog, DialogContent } from '@/components/ui/Dialog'
import { Logo } from '@/components/brand/Logo'

export function AboutDialog() {
  const open = useUi((s) => s.aboutOpen)
  const setOpen = useUi((s) => s.setAboutOpen)
  const { data: meta } = useMeta()
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="sm" title="About Annotamate" bodyClassName="px-6 py-6">
        <div className="flex flex-col items-center gap-4 text-center">
          <Logo variant="wordmark" height={40} />
          <p className="text-base text-muted">
            Self-hosted, collaborative image annotation for teams. Labels are written straight to disk in YOLO, Pascal
            VOC or COCO format.
          </p>
          <dl className="grid w-full grid-cols-2 gap-2 rounded-lg border border-line bg-panel-2 p-3 text-left text-sm">
            <dt className="text-muted">Version</dt>
            <dd className="font-mono text-fg">{meta?.version ?? '…'}</dd>
            <dt className="text-muted">Max upload</dt>
            <dd className="font-mono text-fg">{meta ? `${meta.max_upload_mb} MB` : '…'}</dd>
          </dl>
          <p className="text-xs text-dim">{CREDIT_LINE}</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
