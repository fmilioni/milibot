import type { MouseEvent, ReactNode } from 'react'

import { type LinkKind, type LinkToken, tokenize } from '@/lib/linkify'

import { PathText, RefText } from './RefLinks'

interface LinkProps {
  token: LinkToken
}

function UrlLink({ token }: LinkProps) {
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
      className="text-accent underline underline-offset-2"
    >
      {token.text}
    </a>
  )
}

const LINKS: Record<LinkKind, (props: LinkProps) => ReactNode> = {
  url: UrlLink,
  ref: ({ token }) => <RefText id={token.href} />,
  path: ({ token }) => <PathText path={token.href} variant="text" />,
}

/** The text split into strings and link elements (to combine with other passes such as `withMentions`). */
export function linkifiedNodes(text: string): ReactNode[] {
  return tokenize(text).map((token, i) => {
    if (token.type === 'text') return token.text
    const Link = LINKS[token.kind]
    return <Link key={i} token={token} />
  })
}

/**
 * Plain text with its links made clickable. Renders a fragment, so the caller's `truncate`,
 * `line-clamp` and `whitespace-pre-wrap` keep working.
 */
export function LinkifiedText({ text }: { text: string }) {
  return <>{linkifiedNodes(text)}</>
}
