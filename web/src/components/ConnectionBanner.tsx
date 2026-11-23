import { useEffect, useState } from 'react'
import { WifiOff } from 'lucide-react'
import { realtime, useRealtime } from '@/stores/realtime'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Feedback'

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}

/** "Connection lost / reconnecting" strip under the top bar (debounced to avoid flashes). */
export function ConnectionBanner() {
  const connection = useRealtime((s) => s.connection)
  const everConnected = useRealtime((s) => s.everConnected)
  const online = useOnline()
  const lost = everConnected && connection !== 'open' && connection !== 'closed'
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (!lost && online) {
      const t = setTimeout(() => setShow(false), 0)
      return () => clearTimeout(t)
    }
    const t = setTimeout(() => setShow(true), online ? 1500 : 0)
    return () => clearTimeout(t)
  }, [lost, online])

  if (!show) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-8 shrink-0 animate-slide-down items-center justify-center gap-2 border-b border-warn/30 bg-warn-soft px-3 text-sm text-fg"
    >
      {online ? <Spinner className="size-3.5 text-warn" /> : <WifiOff className="size-3.5 text-warn" aria-hidden />}
      <span>
        {online
          ? 'Connection lost. Reconnecting… Live updates and edit locks are paused.'
          : 'You are offline. Changes stay on this page until the connection returns.'}
      </span>
      {online && (
        <Button size="xs" variant="ghost" onClick={() => realtime.reconnectNow()}>
          Retry now
        </Button>
      )}
    </div>
  )
}
