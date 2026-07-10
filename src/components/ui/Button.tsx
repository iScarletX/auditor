import type { ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

// Material 3 风：胶囊形(全圆角)、纯色不用渐变(渐变是廉价感来源)、hover 靠轻微阴影和色阶变化
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-full text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#059669]/40 disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        primary: 'bg-[#059669] text-white hover:bg-[#047857] hover:shadow-m3-md active:bg-[#036048]',
        secondary: 'border border-[#c8d3cc] bg-white text-[#047857] hover:bg-[#ecfdf5] hover:border-[#059669]/30',
        ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
        danger: 'bg-[#b3261e] text-white hover:bg-[#a01c15] hover:shadow-m3-md',
      },
      size: {
        sm: 'h-8 px-4',
        md: 'h-10 px-6',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}
