import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Upload } from 'lucide-react'
import { toast } from 'sonner'
import { uploadImages } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { pluralize } from '@/lib/utils'
import { useMeta } from '@/hooks/queries'
import { Button } from '@/components/ui/Button'
import { invalidateAfterImageChanges } from './imagesTableUtils'

const BATCH = 20
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff,.tif,.tiff,.jpg,.jpeg,.png,.webp,.bmp,.gif'

/** Manager upload: sends files in batches with progress, then summarises added / skipped files. */
export function UploadButton({ projectId, disabledReason }: { projectId: number; disabledReason?: string }) {
  const input = useRef<HTMLInputElement>(null)
  const qc = useQueryClient()
  const { data: meta } = useMeta()
  const [busy, setBusy] = useState(false)

  async function upload(list: FileList | null) {
    if (!list || list.length === 0) return
    const maxBytes = (meta?.max_upload_mb ?? Infinity) * 1024 * 1024
    const files = Array.from(list)
    const tooBig = files.filter((f) => f.size > maxBytes)
    const ok = files.filter((f) => f.size <= maxBytes)
    const skipped: { filename: string; reason: string }[] = tooBig.map((f) => ({
      filename: f.name,
      reason: `larger than ${meta?.max_upload_mb} MB (${formatBytes(f.size)})`,
    }))
    let added = 0
    setBusy(true)
    const id = toast.loading(`Uploading ${pluralize(ok.length, 'image')}…`)
    try {
      for (let i = 0; i < ok.length; i += BATCH) {
        const batch = ok.slice(i, i + BATCH)
        toast.loading(`Uploading ${Math.min(i + BATCH, ok.length)} of ${ok.length}…`, { id })
        const res = await uploadImages(projectId, batch)
        added += res.added.length
        skipped.push(...res.skipped)
      }
      const details = skipped
        .slice(0, 3)
        .map((s) => `${s.filename}: ${s.reason}`)
        .join('\n')
      const more = skipped.length > 3 ? `\n…and ${skipped.length - 3} more` : ''
      if (added > 0) {
        toast.success(`Added ${pluralize(added, 'image')}`, {
          id,
          description: skipped.length ? `Skipped ${skipped.length}:\n${details}${more}` : undefined,
        })
      } else {
        toast.error('No images were added', { id, description: skipped.length ? `${details}${more}` : undefined })
      }
    } catch (err) {
      toast.error(added ? `Upload stopped after ${pluralize(added, 'image')}` : 'Upload failed', {
        id,
        description: errorMessage(err),
      })
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
      if (added > 0) invalidateAfterImageChanges(qc, projectId)
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => void upload(e.target.files)}
      />
      <Button variant="secondary" loading={busy} disabled={!!disabledReason} title={disabledReason} onClick={() => input.current?.click()}>
        {!busy && <Upload />}
        Upload
      </Button>
    </>
  )
}
