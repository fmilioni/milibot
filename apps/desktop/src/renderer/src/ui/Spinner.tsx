import { LoaderCircle, type LucideProps } from 'lucide-react'

/** Spinning loader that stands still with reduced motion; `label` makes it announce itself. */
export function Spinner({
  size = 14,
  label,
  className = '',
  ...rest
}: {
  size?: number
  label?: string
  className?: string
} & Omit<LucideProps, 'size' | 'className'>) {
  return (
    <LoaderCircle
      size={size}
      className={`shrink-0 animate-spin motion-reduce:animate-none ${className}`}
      {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
      {...rest}
    />
  )
}
