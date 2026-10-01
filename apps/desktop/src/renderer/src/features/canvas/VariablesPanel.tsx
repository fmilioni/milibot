import type { DesignDetail, DesignToken } from '@milibot/shared'
import { Info, SwatchBook, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { tokenValue } from '@/features/canvas/lib/canvas'
import { groupTokens, parseTokenInput, pickerHex, tokenLabel } from '@/features/canvas/lib/design-tokens'
import { useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'

import { useDesignStore } from './store'

const NAME_COLUMN = 158
const THEME_COLUMN = 131

interface Editing {
  token: string
  theme: string
}

/**
 * "Variables": one column per theme (the first is the default), grouped by kind. The user edits
 * values; themes and new tokens come from the bot.
 */
export function VariablesPanel({
  workspaceId,
  design,
  botName,
  onClose,
}: {
  workspaceId: string
  design: DesignDetail
  botName: string
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const editToken = useDesignStore((s) => s.editToken)
  const undo = useDesignStore((s) => (s.undo?.designId === design.id ? s.undo : null))
  const undoTokenEdit = useDesignStore((s) => s.undoTokenEdit)
  const showToast = useAppStore((s) => s.showToast)
  const [editing, setEditing] = useState<Editing | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const groups = groupTokens(design.tokens)
  const themes = design.themes
  const themeList = new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(themes)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !editing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, onClose])

  const commit = async (token: DesignToken, theme: string, value: string | number) => {
    setEditing(null)
    const current = tokenValue(token, theme, themes)
    if (current === value) return
    try {
      await editToken(workspaceId, design.id, token, theme, value)
    } catch {
      showToast('error')
    }
  }

  const undoToken = undo ? design.tokens.find((tk) => tk.name === undo.token) : undefined
  const width = NAME_COLUMN + 28 + THEME_COLUMN * themes.length

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t('canvas.variables.title')}
      className="flex max-h-[min(600px,calc(100vh-120px))] max-w-[calc(100vw-32px)] min-w-[440px] flex-col overflow-hidden rounded-xl border border-border bg-surface-2 shadow-[0_12px_32px_rgba(0,0,0,0.18)] dark:shadow-[0_12px_32px_rgba(0,0,0,0.5)]"
      style={{ width }}
    >
      <div className="flex h-[41px] shrink-0 items-center justify-between gap-3 border-b border-border px-3.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="text-md font-bold text-fg">{t('canvas.variables.title')}</h2>
          <span className="truncate text-xs text-fg-muted">
            {t(themes.length === 1 ? 'canvas.variables.summaryOne' : 'canvas.variables.summary', {
              count: design.tokens.length,
              themes: themeList,
            })}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common.close')}
          className="focus-ring flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-surface-3"
        >
          <X size={14} />
        </button>
      </div>
      {design.tokens.length === 0 ? (
        <p className="px-3.5 py-6 text-center text-sm text-fg-muted">{t('canvas.variables.empty')}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" role="table" aria-label={t('canvas.variables.title')}>
          <div
            role="row"
            className="sticky top-0 z-sticky flex h-7 items-center bg-surface px-3.5 text-2xs font-semibold tracking-wide text-fg-muted uppercase"
          >
            <span role="columnheader" className="shrink-0" style={{ width: NAME_COLUMN }}>
              {t('canvas.variables.name')}
            </span>
            {themes.map((theme, i) => (
              <span
                key={theme}
                role="columnheader"
                className="flex shrink-0 items-center gap-1 truncate pr-2"
                style={{ width: THEME_COLUMN }}
              >
                <SwatchBook size={10} className="shrink-0" aria-hidden />
                <span className="truncate">
                  {i === 0 ? t('canvas.variables.defaultTheme', { name: theme }) : theme}
                </span>
              </span>
            ))}
          </div>
          {groups.map(({ group, tokens }) => (
            <div key={group} role="rowgroup">
              <div className="px-3.5 pt-2.5 pb-1 text-xs font-semibold text-fg">
                {t(`canvas.variables.groups.${group}`)}
              </div>
              {tokens.map((token) => {
                const rowEditing = editing?.token === token.name
                return (
                  <div
                    key={token.name}
                    role="row"
                    className={cn('flex h-[29px] items-center px-3.5', rowEditing && 'bg-accent-soft')}
                  >
                    <span
                      role="rowheader"
                      className="shrink-0 truncate pr-2 font-mono text-xs text-fg-secondary"
                      style={{ width: NAME_COLUMN }}
                      title={token.name}
                    >
                      {tokenLabel(token)}
                    </span>
                    {themes.map((theme, i) => {
                      if (token.value !== null && i > 0)
                        return (
                          <span
                            key={theme}
                            role="cell"
                            className="shrink-0 text-xs text-fg-muted"
                            style={{ width: THEME_COLUMN }}
                          >
                            {t('canvas.variables.same')}
                          </span>
                        )
                      const value = tokenValue(token, theme, themes)
                      const active = rowEditing && editing?.theme === theme
                      return (
                        <span
                          key={theme}
                          role="cell"
                          className="shrink-0 pr-2"
                          style={{ width: THEME_COLUMN }}
                        >
                          {active ? (
                            <TokenEditor
                              token={token}
                              value={value}
                              label={t('canvas.variables.editIn', { name: tokenLabel(token), theme })}
                              onCommit={(next) => void commit(token, theme, next)}
                              onCancel={() => setEditing(null)}
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => setEditing({ token: token.name, theme })}
                              aria-label={t(
                                token.value !== null ? 'canvas.variables.edit' : 'canvas.variables.editIn',
                                { name: tokenLabel(token), theme, value: String(value ?? '') },
                              )}
                              className="focus-ring flex h-[21px] w-full min-w-0 items-center gap-1.5 rounded-md px-1 text-left hover:bg-surface-3"
                            >
                              {token.type === 'color' && (
                                <span
                                  className="size-3.5 shrink-0 rounded border border-black/10 dark:border-white/20"
                                  style={{ background: String(value ?? 'transparent') }}
                                  aria-hidden
                                />
                              )}
                              <span className="truncate font-mono text-xs text-fg">
                                {String(value ?? '')}
                              </span>
                            </button>
                          )}
                        </span>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          ))}
          <div className="h-2" />
        </div>
      )}
      <div className="flex shrink-0 items-center gap-3 border-t border-border bg-surface px-3.5 py-2.5">
        <Info size={13} className="shrink-0 text-fg-secondary" aria-hidden />
        <p className="min-w-0 flex-1 text-xs leading-[1.4] text-fg-secondary">
          {undo && undoToken
            ? t(undo.theme ? 'canvas.variables.changed' : 'canvas.variables.changedAll', {
                name: tokenLabel(undoToken),
                theme: undo.theme ?? '',
                bot: botName,
              }) +
              ' ' +
              t('canvas.variables.structure')
            : t('canvas.variables.structure')}
        </p>
        {undo && (
          <button
            type="button"
            onClick={() => void undoTokenEdit(workspaceId).catch(() => showToast('error'))}
            className="focus-ring shrink-0 rounded text-xs font-semibold text-accent hover:underline"
          >
            {t('canvas.variables.undo')}
          </button>
        )}
      </div>
    </div>
  )
}

/** Inline editor of one value: color picker + text for colors, a text field for the rest. */
function TokenEditor({
  token,
  value,
  label,
  onCommit,
  onCancel,
}: {
  token: DesignToken
  value: string | number | null
  label: string
  onCommit: (value: string | number) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState(String(value ?? ''))
  const [invalid, setInvalid] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  const submit = (raw: string) => {
    if (done.current) return
    const parsed = parseTokenInput(token.type, raw)
    if (!parsed.ok) {
      setInvalid(true)
      return
    }
    done.current = true
    onCommit(parsed.value)
  }

  const hex = token.type === 'color' ? pickerHex(text) : null
  return (
    <span
      className={cn(
        'flex h-[21px] w-full items-center gap-1.5 rounded-md border bg-surface-2 px-1',
        invalid ? 'border-danger' : 'border-accent',
      )}
    >
      {token.type === 'color' && (
        <label className="relative size-3.5 shrink-0 cursor-pointer overflow-hidden rounded border border-black/10 dark:border-white/20">
          <span className="absolute inset-0" style={{ background: text }} aria-hidden />
          <input
            type="color"
            aria-label={t('canvas.variables.pickColor')}
            value={hex ?? '#000000'}
            onChange={(e) => {
              setText(e.target.value.toUpperCase())
              setInvalid(false)
            }}
            onBlur={(e) => {
              if (e.relatedTarget !== input.current) submit(e.target.value.toUpperCase())
            }}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
      )}
      <input
        ref={input}
        value={text}
        aria-label={label}
        aria-invalid={invalid}
        title={invalid ? t('canvas.variables.invalid') : undefined}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          setInvalid(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit(text)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            done.current = true
            onCancel()
          }
        }}
        onBlur={(e) => {
          if (e.relatedTarget instanceof HTMLInputElement && e.relatedTarget.type === 'color') return
          if (invalid) {
            done.current = true
            onCancel()
          } else submit(text)
        }}
        className="selectable min-w-0 flex-1 bg-transparent font-mono text-xs text-fg outline-none"
      />
    </span>
  )
}
