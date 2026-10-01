import { Check, Copy, FileText } from 'lucide-react'
import {
  Children,
  cloneElement,
  type ComponentProps,
  isValidElement,
  memo,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/cn'
import { type MentionTarget, splitMentions } from '@/lib/mentions'
import { rehypeReveal, type RevealOptions } from '@/lib/rehype-reveal'
import { REVEAL_FADE_MS } from '@/lib/reveal'

import { Tooltip } from './Tooltip'

function MentionChip({ text }: { text: string }) {
  return (
    <span className="rounded-[5px] bg-accent-soft px-[5px] py-px font-semibold text-accent" data-mention>
      {text}
    </span>
  )
}

/** Replaces `@Name` inside plain-text children with mention chips, leaving elements untouched. */
export function withMentions(children: ReactNode, targets: MentionTarget[]): ReactNode {
  if (targets.length === 0) return children
  return Children.map(children, (child) => {
    if (typeof child === 'string') {
      const segments = splitMentions(child, targets)
      if (segments.length === 1 && segments[0]?.type === 'text') return child
      return segments.map((segment, i) =>
        segment.type === 'mention' ? <MentionChip key={i} text={segment.text} /> : segment.text,
      )
    }
    if (
      isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child) &&
      child.type !== 'code' &&
      child.props.node?.tagName !== 'code' &&
      child.props.children
    ) {
      return cloneElement(child, undefined, withMentions(child.props.children, targets))
    }
    return child
  })
}

function CodeBlock({
  language,
  code,
  copyLabel,
  copiedLabel,
}: {
  language: string | null
  code: string
  copyLabel: string
  copiedLabel: string
}) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="group/code relative my-2 overflow-hidden rounded-lg border border-border bg-surface">
      {language && (
        <div className="border-b border-border px-3 py-1 font-mono text-2xs tracking-wide text-fg-muted uppercase">
          {language}
        </div>
      )}
      <Tooltip content={copied ? copiedLabel : copyLabel}>
        <button
          type="button"
          aria-label={copied ? copiedLabel : copyLabel}
          onClick={() =>
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            })
          }
          className="focus-ring absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md bg-surface-2 text-fg-muted opacity-0 group-hover/code:opacity-100 hover:text-fg focus-visible:opacity-100"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </Tooltip>
      <pre className="scroll-slim overflow-x-auto px-3 py-2.5 font-mono text-code leading-[1.55] text-fg">
        <code>{code}</code>
      </pre>
    </div>
  )
}

/** Text revealed moments ago (see `rehype-reveal`): fades in from the phase it was born at. */
function RevealSpan({ node: _node, ...props }: ComponentProps<'span'> & { node?: unknown }) {
  const ref = useRef<HTMLSpanElement>(null)
  const born = (props as { 'data-reveal-born'?: number | string })['data-reveal-born']
  useLayoutEffect(() => {
    const el = ref.current
    if (born === undefined || !el) return
    const age = performance.now() - Number(born)
    if (!(age < REVEAL_FADE_MS)) return
    const animation = el.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: REVEAL_FADE_MS,
      delay: -age,
      easing: 'cubic-bezier(0.2, 0.6, 0.35, 1)',
      fill: 'backwards',
    })
    return () => animation.cancel()
  }, [born])
  return <span ref={ref} {...props} />
}

const NO_MENTIONS: MentionTarget[] = []

interface MarkdownProps {
  text: string
  mentions?: MentionTarget[]
  /** Labels of a code block's copy button; default to the app's "Copy code" / "Copied". */
  copyLabel?: string
  copiedLabel?: string
  /** Live reveal decorations (fading chunks, caret); omitted for settled messages. */
  reveal?: RevealOptions
  /** 13px body (bubbles of the internal conversation panel). */
  compact?: boolean
  /** Renders `asset:<sha>` images (board cards). */
  renderAsset?: (sha: string, alt: string) => ReactNode
  /** Renders the other images (the page can't load them itself: VM paths, CSP); left out without it. */
  renderImage?: (src: string, alt: string) => ReactNode
}

const keepAssets = (url: string) => (url.startsWith('asset:') ? url : defaultUrlTransform(url))

/** Chat markdown: GFM, inline code chips, code blocks with copy, `@mention` chips. Raw HTML is never rendered. */
export const Markdown = memo(function Markdown({
  text,
  mentions = NO_MENTIONS,
  copyLabel,
  copiedLabel,
  reveal,
  compact = false,
  renderAsset,
  renderImage,
}: MarkdownProps) {
  const { t } = useTranslation()
  const copy = copyLabel ?? t('chat.copyCode')
  const copied = copiedLabel ?? t('chat.copied')
  const components = useMemo(() => {
    const base = markdownComponents(mentions, copy, copied)
    if (!renderAsset && !renderImage) return base
    return {
      ...base,
      img: ({ src, alt }) => {
        if (typeof src !== 'string') return null
        if (src.startsWith('asset:')) return renderAsset ? renderAsset(src.slice(6), alt ?? '') : null
        return renderImage ? renderImage(src, alt ?? '') : null
      },
    } satisfies Components
  }, [mentions, copy, copied, renderAsset, renderImage])
  return (
    <div
      className={cn(
        'markdown selectable',
        compact ? 'text-base' : 'text-md',
        'leading-[1.5] break-words text-fg',
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={reveal ? [[rehypeReveal, reveal]] : undefined}
        components={components}
        {...(renderAsset ? { urlTransform: keepAssets } : {})}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

function markdownComponents(mentions: MentionTarget[], copyLabel: string, copiedLabel: string): Components {
  const m = (children: ReactNode) => withMentions(children, mentions)
  return {
    span: RevealSpan,
    // An image renders as a block (thumbnail, card), which can't sit inside a <p>.
    p: ({ children, node }) =>
      node?.children.some((c) => c.type === 'element' && c.tagName === 'img') ? (
        <div className="my-2">{m(children)}</div>
      ) : (
        <p className="my-2">{m(children)}</p>
      ),
    li: ({ children }) => <li className="my-0.5">{m(children)}</li>,
    td: ({ children }) => <td className="border border-border px-2 py-1">{m(children)}</td>,
    th: ({ children }) => (
      <th className="border border-border bg-surface px-2 py-1 text-left font-semibold">{m(children)}</th>
    ),
    ul: ({ children }) => <ul className="my-2 list-disc pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-2 list-decimal pl-5">{children}</ol>,
    h1: ({ children }) => <h3 className="mt-3 mb-1.5 text-xl font-semibold">{m(children)}</h3>,
    h2: ({ children }) => <h3 className="mt-3 mb-1.5 text-lg font-semibold">{m(children)}</h3>,
    h3: ({ children }) => <h4 className="mt-3 mb-1 text-md font-semibold">{m(children)}</h4>,
    blockquote: ({ children }) => (
      <blockquote className="my-2 border-l-2 border-border pl-3 text-fg-secondary">{children}</blockquote>
    ),
    table: ({ children }) => (
      <div className="scroll-slim my-2 overflow-x-auto">
        <table className="border-collapse text-base">{children}</table>
      </div>
    ),
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
        {children}
      </a>
    ),
    hr: () => <hr className="my-3 border-border" />,
    img: () => null,
    pre: ({ children }) => {
      const child = Children.toArray(children)[0]
      if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
        const language = /language-(\S+)/.exec(child.props.className ?? '')?.[1] ?? null
        const code = String(child.props.children ?? '').replace(/\n$/, '')
        return <CodeBlock language={language} code={code} copyLabel={copyLabel} copiedLabel={copiedLabel} />
      }
      return <pre>{children}</pre>
    },
    code: ({ children, className }) => {
      if (className) return <code className={className}>{children}</code>
      const value = String(children)
      if (/^\/(workspace|home)\//.test(value)) {
        return (
          <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface px-1.5 align-[-2px] font-mono text-sm text-fg-secondary">
            <FileText size={12} className="shrink-0 text-fg-muted" />
            <span className="truncate">{value}</span>
          </span>
        )
      }
      return (
        <code className="rounded-[5px] bg-surface-3 px-1 py-px font-mono text-code text-fg">{children}</code>
      )
    },
  }
}
