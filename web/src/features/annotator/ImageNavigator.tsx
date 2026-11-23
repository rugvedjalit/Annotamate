import { useState, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { getImages } from '@/lib/endpoints'
import { errorMessage } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { useBindings } from '@/hooks/useBindings'
import { IconButton } from '@/components/ui/IconButton'
import { Tooltip } from '@/components/ui/Tooltip'
import { useWorkspace } from './workspaceContext'

/** ‹ filename · n / total › — click the field to jump by number or file name. */
export function ImageNavigator() {
  const ws = useWorkspace()
  const bindings = useBindings()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const { nav, image } = ws

  async function jump(e: FormEvent) {
    e.preventDefault()
    const value = text.trim()
    if (!value) {
      setEditing(false)
      return
    }
    setBusy(true)
    try {
      let id: number | undefined
      if (/^\d+$/.test(value)) {
        const n = Number(value)
        if (nav.total !== null && (n < 1 || n > nav.total)) {
          toast.error(`Enter a number between 1 and ${formatNumber(nav.total)}.`)
          return
        }
        id = (await getImages(ws.projectId, ws.filters, n - 1, 1)).items[0]?.id
      } else {
        id = (await getImages(ws.projectId, { ...ws.filters, q: value }, 0, 1)).items[0]?.id
      }
      if (id === undefined) {
        toast.error(`No image matches “${value}” in the current filter.`)
        return
      }
      setEditing(false)
      await nav.goTo(id)
    } catch (err) {
      toast.error('Could not jump to that image', { description: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <IconButton
        variant="outline"
        label="Previous image"
        shortcut={bindings['image.prev']}
        icon={<ChevronLeft />}
        disabled={nav.prevId === null}
        onClick={nav.goPrev}
      />
      {editing ? (
        <form onSubmit={(e) => void jump(e)} className="flex">
          <input
            autoFocus
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => !busy && setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setEditing(false)
              }
            }}
            placeholder="Image number or file name, then Enter"
            aria-label="Jump to image number or file name"
            className="h-[30px] w-[min(340px,32vw)] rounded-lg border border-accent bg-panel-2 px-3 font-mono text-xs text-fg ring-[3px] ring-accent/20 placeholder:font-sans placeholder:text-dim focus:outline-none"
          />
        </form>
      ) : (
        <Tooltip content="Jump to an image (type a number or file name)">
          <button
            type="button"
            onClick={() => {
              setText('')
              setEditing(true)
            }}
            className="flex h-[30px] w-[min(340px,32vw)] min-w-0 items-center justify-between gap-3 rounded-lg border border-line bg-panel-2 px-3 hover:border-line-strong"
          >
            <span className="truncate font-mono text-xs text-fg" title={image?.rel_path}>
              {image?.filename ?? '…'}
            </span>
            <span className="shrink-0 text-xs text-muted tabular">
              <span className="font-mono text-fg">{nav.index >= 0 ? formatNumber(nav.index + 1) : '–'}</span>
              {' / '}
              {nav.total !== null ? formatNumber(nav.total) : '…'}
            </span>
          </button>
        </Tooltip>
      )}
      <IconButton
        variant="outline"
        label="Next image"
        shortcut={bindings['image.next']}
        icon={<ChevronRight />}
        disabled={nav.nextId === null}
        onClick={nav.goNext}
      />
    </div>
  )
}
