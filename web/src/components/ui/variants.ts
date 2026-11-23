// Class-variance definitions shared by the primitives (and by links styled as buttons).
import { cva } from 'class-variance-authority'

export const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-[background-color,border-color,color,box-shadow,filter] duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg shadow-sm hover:bg-accent-hover',
        secondary: 'border border-line bg-panel-2 text-fg hover:border-line-strong hover:bg-hover',
        ghost: 'text-muted hover:bg-hover hover:text-fg',
        outline: 'border border-line bg-transparent text-fg hover:bg-hover',
        danger: 'bg-danger text-white shadow-sm hover:brightness-110',
        'danger-ghost': 'text-danger hover:bg-danger-soft',
        success: 'bg-ok text-white shadow-sm hover:brightness-110',
        warn: 'bg-warn text-white shadow-sm hover:brightness-110',
        link: 'h-auto px-0 text-accent-text underline-offset-2 hover:underline',
      },
      size: {
        xs: 'h-6 px-2 text-xs [&_svg]:size-3.5',
        sm: 'h-7 px-2.5 text-sm [&_svg]:size-3.5',
        md: 'h-8 px-3 text-base [&_svg]:size-4',
        lg: 'h-9 px-4 text-md [&_svg]:size-4',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export const iconButtonVariants = cva(
  'relative inline-grid shrink-0 select-none place-items-center rounded-md transition-[background-color,color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        ghost: 'text-muted hover:bg-hover hover:text-fg',
        outline: 'border border-line bg-panel-2 text-fg hover:border-line-strong hover:bg-hover',
        solid: 'bg-accent text-accent-fg shadow-sm hover:bg-accent-hover',
        danger: 'text-muted hover:bg-danger-soft hover:text-danger',
      },
      size: {
        xs: 'size-[22px] [&_svg]:size-3.5',
        sm: 'size-[26px] [&_svg]:size-4',
        md: 'size-[30px] [&_svg]:size-4',
        lg: 'size-8 [&_svg]:size-[18px]',
      },
      active: {
        true: '',
        false: '',
      },
    },
    compoundVariants: [
      { variant: 'ghost', active: true, className: 'bg-accent-soft text-accent-text hover:bg-accent-soft hover:text-accent-text' },
      { variant: 'outline', active: true, className: 'border-accent bg-accent-soft text-accent-text' },
    ],
    defaultVariants: { variant: 'ghost', size: 'md', active: false },
  },
)

export const badgeVariants = cva(
  'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[5px] font-semibold [&_svg]:size-3',
  {
    variants: {
      variant: {
        neutral: 'bg-hover text-muted',
        accent: 'bg-accent-soft text-accent-text',
        warn: 'bg-warn-soft text-warn',
        ok: 'bg-ok-soft text-ok',
        danger: 'bg-danger-soft text-danger',
        outline: 'border border-line text-muted',
        solid: 'bg-accent text-accent-fg',
      },
      size: {
        sm: 'h-[18px] px-1.5 text-2xs tracking-wide',
        md: 'h-5 px-2 text-xs',
      },
    },
    defaultVariants: { variant: 'neutral', size: 'sm' },
  },
)
