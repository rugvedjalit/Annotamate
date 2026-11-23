import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { IconButton } from '@/components/ui/IconButton'

/** Copies text to the clipboard with a short confirmation state. */
export function CopyButton({ text, label = 'Copy to clipboard' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy', { description: 'Your browser blocked clipboard access. Select the text and copy it manually.' })
    }
  }
  return (
    <IconButton
      size="sm"
      label={copied ? 'Copied' : label}
      icon={copied ? <Check className="text-ok" /> : <Copy />}
      disabled={!text}
      onClick={() => void copy()}
    />
  )
}
