import { ArrowLeft, Copy, File, FolderOpen, RefreshCw, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { getSkillUsage } from '@/features/skills/api'
import { skillOrigin, sourceChips, splitFrontmatter } from '@/features/skills/lib/skills'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { isApiError } from '@/lib/errors'
import { AsyncView } from '@/ui/AsyncView'
import { Button } from '@/ui/Button'
import { InlineConfirm } from '@/ui/Confirm'
import { Markdown } from '@/ui/Markdown'
import { MoreMenu } from '@/ui/MoreMenu'
import { Switch } from '@/ui/Switch'
import { Tooltip } from '@/ui/Tooltip'

import { SkillIconBox, SourceChip, useSkillError, useSkillText } from './SkillParts'
import { SkillSideCards } from './SkillSideCards'
import { useSkillsStore } from './store'
import { useSkillMenu } from './use-skill-menu'

/** One skill opened from Settings › Skills: SKILL.md viewer/editor and side cards. */
export function SkillDetailView({ skillId }: { skillId: string }) {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const bots = useAppStore((s) => s.bots)
  const showToast = useAppStore((s) => s.showToast)
  const summary = useSkillsStore((s) => s.skills.find((k) => k.id === skillId))
  const getSkill = useSkillsStore((s) => s.get)
  const openSkill = useSkillsStore((s) => s.openSkill)
  const update = useSkillsStore((s) => s.update)
  const remove = useSkillsStore((s) => s.remove)
  const duplicate = useSkillsStore((s) => s.duplicate)
  const putContent = useSkillsStore((s) => s.putContent)
  const updateSource = useSkillsStore((s) => s.updateSource)
  const text = useSkillText()
  const errorText = useSkillError()
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [draft, setDraft] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const fail = () => showToast('error')

  // `skill.updated` invalidates the detail (and its usage) whenever the skill changes.
  const {
    data: detail,
    error,
    reload,
  } = useApiQuery(queryKeys.skill(workspaceId, skillId), () => getSkill(workspaceId, skillId))
  const { data: usage } = useApiQuery(queryKeys.skillUsage(workspaceId, skillId), () =>
    getSkillUsage(workspaceId, skillId),
  )
  const loaded = detail ? (summary ? { ...detail, ...summary } : detail) : null
  const github = loaded?.source === 'import' && skillOrigin(loaded)?.kind === 'github'

  const { run: fromSource, busy: updating } = useApiMutation(() => updateSource(workspaceId, skillId, true), {
    onSuccess: () => {
      reload()
      showToast('skillUpdated')
    },
  })
  const { run: saveContent, busy: saving } = useApiMutation(
    (content: { id: string; skillMd: string }) => putContent(workspaceId, content.id, content.skillMd),
    { errorToast: false },
  )
  const entries = useSkillMenu(loaded ?? { id: skillId, source: 'builtin', error: null, editable: false }, {
    onUpdate: github ? null : () => void fromSource(),
    onDelete: () => setConfirming(true),
  })

  const back = (
    <button
      type="button"
      onClick={() => openSkill(null)}
      className="focus-ring flex w-fit items-center gap-1.5 rounded text-sm font-semibold text-fg-secondary hover:text-fg"
    >
      <ArrowLeft size={13} aria-hidden />
      {t('skills.title')}
    </button>
  )

  if (!detail || !loaded)
    return (
      <div className="mx-auto flex w-full max-w-[1104px] flex-col gap-4">
        {back}
        {isApiError(error, 'not_found') ? (
          <p className="text-base text-fg-muted">{t('skills.detail.missing')}</p>
        ) : (
          <AsyncView
            data={null}
            error={error}
            onRetry={reload}
            className="flex items-center gap-2 text-sm text-fg-muted"
          >
            {() => null}
          </AsyncView>
        )}
      </div>
    )

  const skill = loaded
  const { name, description } = text(skill)
  const chips = sourceChips(skill, bots)
  const readOnly = !skill.editable
  const view = detail.skillMd ? splitFrontmatter(detail.skillMd) : null

  const startEdit = () => {
    setDraft(detail.skillMd ?? '')
    setSaveError(null)
    setMode('edit')
  }
  const save = async () => {
    setSaveError(null)
    try {
      await saveContent({ id: skill.id, skillMd: draft })
      reload()
      setMode('view')
      showToast('skillSaved')
    } catch (err) {
      setSaveError(isApiError(err) ? err.message : t('toast.error'))
    }
  }
  const copy = () => void toastOnError(duplicate(workspaceId, skill.id).then((c) => openSkill(c.id)))

  return (
    <div className="mx-auto flex w-full max-w-[1104px] flex-col gap-4">
      {back}
      <header className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <SkillIconBox skill={skill} size={40} />
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-5xl leading-[27px] font-bold text-fg">{name}</h1>
              {skill.source === 'builtin' && (
                <span className="shrink-0 text-sm text-fg-muted">{skill.slug}</span>
              )}
              {chips.map((chip) => (
                <SourceChip key={chip.kind} chip={chip} />
              ))}
            </div>
            <p className="truncate text-base text-fg-secondary">{description}</p>
          </div>
        </div>
        <div className="no-drag flex shrink-0 items-center gap-2">
          {detail.folderPath && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void window.milibot.revealPath(detail.folderPath as string).catch(fail)}
            >
              <FolderOpen size={13} className="text-fg-secondary" />
              {t('skills.openFolder')}
            </Button>
          )}
          {github && (
            <Button size="sm" variant="primary" disabled={updating} onClick={() => void fromSource()}>
              <RefreshCw size={13} className={updating ? 'animate-spin motion-reduce:animate-none' : ''} />
              {t('skills.detail.updateFromGithub')}
            </Button>
          )}
          {!skill.error && (
            <Switch
              checked={skill.enabled}
              label={t('skills.enable', { name })}
              onChange={(enabled) => void toastOnError(update(workspaceId, skill.id, { enabled }))}
            />
          )}
          {entries.length > 0 && (
            <MoreMenu label={t('skills.more', { name })} entries={entries} menuLabel={name} />
          )}
        </div>
      </header>
      {confirming && (
        <InlineConfirm
          message={t('skills.deleteConfirm', { name })}
          confirmLabel={t('skills.menu.delete')}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void toastOnError(remove(workspaceId, skill.id))}
        />
      )}
      <div className="flex items-start gap-5">
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-surface-2">
          <div className="flex h-[43px] items-center gap-2.5 border-b border-border px-3">
            {detail.skillMd !== null && (
              <div role="tablist" className="flex gap-0.5 rounded-[7px] bg-surface-3 p-0.5">
                {(['view', 'edit'] as const).map((id) => {
                  const disabled = id === 'edit' && readOnly
                  return (
                    <Tooltip key={id} content={disabled ? t('skills.detail.readOnly') : null}>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={mode === id}
                        aria-disabled={disabled || undefined}
                        onClick={() =>
                          !disabled && (id === 'edit' ? mode !== 'edit' && startEdit() : setMode('view'))
                        }
                        className={cn(
                          'focus-ring h-[23px] rounded-[5px] px-3 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
                          mode === id ? 'bg-surface-2 font-semibold text-fg shadow-sm' : 'text-fg-secondary',
                        )}
                      >
                        {t(id === 'view' ? 'skills.detail.view' : 'skills.detail.edit')}
                      </button>
                    </Tooltip>
                  )
                })}
              </div>
            )}
            <span className="flex items-center gap-1.5 text-xs text-fg-secondary">
              <File size={12} className="text-fg-muted" aria-hidden />
              <span className="font-mono">SKILL.md</span>
            </span>
            <span className="flex-1" />
            {mode === 'edit' ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => setMode('view')}>
                  {t('common.cancel')}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={saving || draft === detail.skillMd}
                  onClick={() => void save()}
                >
                  {t('common.save')}
                </Button>
              </>
            ) : skill.error ? null : (
              <span className="text-xs text-fg-muted">
                {t('skills.meta.tokensOnLoad', {
                  tokens: new Intl.NumberFormat(i18n.language, { notation: 'compact' }).format(skill.tokens),
                })}
              </span>
            )}
          </div>
          {skill.error && (
            <div className="flex items-center gap-2.5 border-b border-border bg-danger-tint px-4 py-2.5 text-sm text-fg">
              <TriangleAlert size={14} className="shrink-0 text-danger" aria-hidden />
              {errorText(skill.error)}
            </div>
          )}
          {readOnly && skill.source === 'builtin' && mode === 'view' && (
            <div className="flex items-center gap-2.5 border-b border-border px-4 py-2 text-sm text-fg-secondary">
              <span className="min-w-0 flex-1">{t('skills.detail.builtinNote')}</span>
              <Button size="sm" variant="outline" onClick={copy}>
                <Copy size={12} />
                {t('skills.menu.duplicateToEdit')}
              </Button>
            </div>
          )}
          {mode === 'edit' ? (
            <div className="flex flex-col gap-2 p-3">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                aria-label="SKILL.md"
                className="selectable min-h-[520px] w-full resize-y rounded-lg border border-border bg-surface px-3 py-2.5 font-mono text-sm leading-[1.55] text-fg outline-none focus:border-accent"
              />
              {saveError && <p className="text-sm text-danger">{saveError}</p>}
            </div>
          ) : view ? (
            <>
              {view.fields.length > 0 && (
                <dl className="flex flex-col gap-1.5 bg-surface px-4 py-3">
                  {view.fields.map((field) => (
                    <div key={field.key} className="flex gap-2.5 font-mono text-xs leading-[15px]">
                      <dt className="w-[76px] shrink-0 text-fg-muted">{field.key}</dt>
                      <dd className="selectable min-w-0 flex-1 break-words text-fg">{field.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="skill-markdown px-5 py-2">
                <Markdown text={view.body} compact />
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-2 px-5 py-4 text-base text-fg-secondary">
              <p>{skill.description}</p>
              <p className="text-sm text-fg-muted">{t('skills.detail.taughtNote')}</p>
            </div>
          )}
        </section>
        <SkillSideCards skill={skill} detail={detail} usage={usage} />
      </div>
    </div>
  )
}
