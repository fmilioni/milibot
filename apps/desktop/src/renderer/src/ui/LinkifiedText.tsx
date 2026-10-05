import type { MouseEvent, ReactNode } from 'react'

import { cn } from '@/lib/cn'
import { type LinkKind, type LinkToken, tokenize } from '@/lib/linkify'

interface LinkProps {
  token: LinkToken
  className?: string
}

function UrlLink({ token, className }: LinkProps) {
  // Navigation away from the app's page is blocked, so the click opens the system browser itself;
  // `target=_blank` only backs it up through the window-open handler.
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    event.stopPropagation()
    void window.milibot.openExternal(token.href)
  }
  return (
    <a
      href={token.href}
      target="_blank"
      rel="noreferrer"
      onClick={open}
      className={cn('text-accent underline underline-offset-2', className)}
    >
      {token.text}
    </a>
  )
}

const LINKS: Record<LinkKind, (props: LinkProps) => ReactNode> = { url: UrlLink }

/**
 * Plain text with its links made clickable. Renders a fragment, so the caller's `truncate`,
 * `line-clamp` and `whitespace-pre-wrap` keep working.
 */
export function LinkifiedText({ text, linkClassName }: { text: string; linkClassName?: string }) {
  return (
    <>
      {tokenize(text).map((token, i) => {
        if (token.type === 'text') return token.text
        const Link = LINKS[token.kind]
        return <Link key={i} token={token} className={linkClassName} />
      })}
    </>
  )
}
