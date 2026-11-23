import { assetUrl } from '@/lib/config'
import { cn } from '@/lib/utils'
import { useUi } from '@/stores/ui'

interface LogoProps {
  variant?: 'wordmark' | 'mark'
  /** Height in px; width follows the image aspect ratio. */
  height?: number
  className?: string
  /** Force the variant for a given background instead of following the theme. */
  on?: 'dark' | 'light'
}

const WORDMARK_RATIO = 1018 / 224

/** The company logo (real brand assets). The wordmark has a light and a dark-background variant. */
export function Logo({ variant = 'wordmark', height = 22, className, on }: LogoProps) {
  const theme = useUi((s) => s.resolvedTheme)
  const background = on ?? theme
  if (variant === 'mark') {
    return (
      <img
        src={assetUrl('brand/mark.png')}
        alt="Annotamate"
        width={height}
        height={height}
        className={cn('select-none', className)}
        draggable={false}
      />
    )
  }
  return (
    <img
      src={assetUrl(background === 'dark' ? 'brand/wordmark-dark.png' : 'brand/wordmark-light.png')}
      alt="Annotamate"
      height={height}
      width={Math.round(height * WORDMARK_RATIO)}
      className={cn('select-none', className)}
      draggable={false}
    />
  )
}
