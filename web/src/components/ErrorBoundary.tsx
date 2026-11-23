import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

interface Props {
  children: ReactNode
  /** Name of the region shown in the fallback ("Inspector", "Files"). */
  name?: string
  className?: string
  /** Changing this value resets the boundary (e.g. the image id). */
  resetKey?: unknown
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
  resetKey: unknown
}

/** Error boundary per panel: a crash in one region never takes the rest of the workspace down. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey, error: null }
    return null
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.name ?? 'app'}] render error`, error, info.componentStack)
  }

  reset = (): void => this.setState({ error: null })

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(error, this.reset)
    return (
      <div
        role="alert"
        className={cn('flex h-full min-h-32 flex-col items-center justify-center gap-2 p-6 text-center', this.props.className)}
      >
        <TriangleAlert className="size-5 text-danger" aria-hidden />
        <div className="text-md font-semibold text-fg">
          {this.props.name ? `${this.props.name} stopped working` : 'Something went wrong'}
        </div>
        <div className="max-w-sm text-sm text-muted">{error.message || 'An unexpected error occurred.'}</div>
        <Button size="sm" onClick={this.reset} className="mt-1">
          <RefreshCw />
          Try again
        </Button>
      </div>
    )
  }
}
