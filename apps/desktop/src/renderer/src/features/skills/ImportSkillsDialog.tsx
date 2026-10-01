import type { BotScope, SkillImportCandidate } from '@milibot/shared'
import { FolderDown, Info, Layers, ShieldAlert, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Notice } from '@/features/settings/SettingsLayout'
import { importablePaths, importErrorKey, isGithubAddress } from '@/features/skills/lib/skills'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { isApiError } from '@/lib/errors'
import { botOptions } from '@/lib/select-options'
import { Button, LinkButton } from '@/ui/Button'
import { Modal } from '@/ui/Modal'
import { MultiSelect } from '@/ui/MultiSelect'
import { Select } from '@/ui/Select'
import { Spinner } from '@/ui/Spinner'

import { CandidateRow } from './CandidateRow'
import { GithubMark, useSkillError, useSkillText } from './SkillParts'
import { useSkillsStore } from './store'
import { useImportScan } from './use-import-scan'

const SHOWN = 5

/** "Import skills": drop or pick paths, a GitHub address or another workspace, then choose. */
export function ImportSkillsDialog({ initialPaths }: { initialPaths: string[] }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const workspaces = useAppStore((s) => s.workspaces)
  const bots = useAppStore((s) => s.bots)
  const openSettings = useAppStore((s) => s.openSettings)
  const showToast = useAppStore((s) => s.showToast)
  const skills = useSkillsStore((s) => s.skills)
  const commit = useSkillsStore((s) => s.commit)
  const closeImport = useSkillsStore((s) => s.closeImport)
  const text = useSkillText()
  const errorText = useSkillError()
  const [url, setUrl] = useState('')
  const {
    scanning,
    error,
    setError,
    scan,
    selected,
    setSelected,
    showAll,
    setShowAll,
    failed,
    setFailed,
    run,
  } = useImportScan(workspaceId, initialPaths)
  const [allowed, setAllowed] = useState<BotScope>('all')
  const [committing, setCommitting] = useState(false)
  const otherWorkspaces = workspaces.filter((w) => w.id !== workspaceId)

  const choose = async () => {
    const paths = importablePaths(
      await window.milibot.chooseOpenPaths({
        title: t('skills.import.chooseTitle'),
        extensions: ['md', 'zip', 'skill'],
      }),
    )
    if (paths.length) void run({ kind: 'paths', paths })
  }

  const searchGithub = () => {
    if (isGithubAddress(url)) void run({ kind: 'github', url: url.trim() })
    else setError({ message: t('skills.import.errors.invalid_url'), githubToken: false })
  }

  const candidates = scan?.candidates ?? []
  const shown = showAll ? candidates : candidates.slice(0, SHOWN)
  const importable = candidates.filter((c) => !c.error)
  const chosen = importable.filter((c) => selected.has(c.path))
  const scripts = chosen.some((c) => c.hasScripts)
  const originLabel = (() => {
    if (!scan) return ''
    if (scan.origin.kind === 'workspace')
      return workspaces.find((w) => w.id === scan.origin.label)?.name ?? scan.origin.label
    return scan.origin.ref ? `${scan.origin.label} · ${scan.origin.ref}` : scan.origin.label
  })()

  const toggle = (path: string) => {
    const next = new Set(selected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setSelected(next)
  }

  const confirm = async () => {
    if (!scan || chosen.length === 0) return
    setCommitting(true)
    try {
      const result = await commit(
        workspaceId,
        scan.scanId,
        chosen.map((c) => c.path),
        allowed,
      )
      if (result.failed.length === 0) {
        showToast('skillsImported')
        closeImport()
        return
      }
      setFailed(result.failed)
      setSelected(new Set(result.failed.map((f) => f.path)))
    } catch (err) {
      const key = importErrorKey(isApiError(err) ? err.details : undefined)
      setError({ message: key ? t(key as never) : t('toast.error'), githubToken: false })
    } finally {
      setCommitting(false)
    }
  }

  const builtinName = (candidate: SkillImportCandidate) => {
    const builtin = skills.find((s) => s.id === candidate.existingSkillId)
    return builtin ? text(builtin).name : candidate.name
  }

  return (
    <Modal
      title={t('skills.import.title')}
      description={t('skills.import.subtitle')}
      width={680}
      onClose={closeImport}
      footer={
        <div className="flex flex-1 items-center gap-2.5">
          <span className="shrink-0 text-sm text-fg-secondary">{t('skills.import.availableFor')}</span>
          <div className="w-[160px]">
            <MultiSelect
              value={allowed}
              onChange={setAllowed}
              label={t('skills.import.availableFor')}
              allLabel={t('skills.access.allChip')}
              placeholder={t('skills.access.none')}
              options={botOptions(bots)}
              tone="surface-2"
              className="h-[27px]! text-sm! font-semibold"
            />
          </div>
          <span className="flex-1" />
          <Button size="sm" variant="outline" className="h-[31px]" onClick={closeImport}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            variant="primary"
            className="h-[31px]"
            disabled={chosen.length === 0 || committing}
            onClick={() => void confirm()}
          >
            {committing && <Spinner size={12} />}
            {chosen.length === 0
              ? t('skills.import.confirmNone')
              : t('skills.import.confirm', { count: chosen.length })}
          </Button>
        </div>
      }
    >
      <div className="flex h-24 shrink-0 flex-col items-center justify-center gap-1.5 rounded-[10px] border border-border bg-surface">
        <span className="flex items-center gap-2 text-base font-semibold text-fg">
          <FolderDown size={16} className="text-fg-secondary" aria-hidden />
          {t('skills.import.drop')}
        </span>
        <span className="flex items-center gap-1 text-sm text-fg-secondary">
          {t('skills.import.or')}
          <LinkButton onClick={() => void toastOnError(choose())}>{t('skills.import.choose')}</LinkButton>
        </span>
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          searchGithub()
        }}
      >
        <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 focus-within:border-accent">
          <GithubMark size={14} className="shrink-0 text-fg-secondary" />
          <input
            data-autofocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('skills.import.githubPlaceholder')}
            aria-label={t('skills.import.githubLabel')}
            className="selectable min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted"
          />
        </label>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          className="h-[31px]"
          disabled={!url.trim() || scanning}
        >
          {t('skills.import.search')}
        </Button>
      </form>
      {otherWorkspaces.length > 0 && (
        <div className="flex items-center gap-2 text-sm text-fg-secondary">
          <Layers size={13} className="shrink-0" aria-hidden />
          <span className="shrink-0">{t('skills.import.fromWorkspace')}</span>
          <div className="w-[220px]">
            <Select
              size="sm"
              tone="surface-2"
              value=""
              label={t('skills.import.fromWorkspace')}
              options={[
                { value: '', label: t('skills.import.workspacePlaceholder'), disabled: true },
                ...otherWorkspaces.map((w) => ({ value: w.id, label: w.name })),
              ]}
              onChange={(id) => id && void run({ kind: 'workspace', workspaceId: id })}
            />
          </div>
        </div>
      )}
      {scanning && (
        <div className="flex items-center gap-2 px-0.5 text-sm text-fg-secondary">
          <Spinner />
          {t('skills.import.searching')}
        </div>
      )}
      {error && !scanning && (
        <div
          className="flex flex-col gap-2.5 rounded-[10px] bg-danger-tint px-3.5 py-2.5 text-sm text-fg"
          role="alert"
        >
          <div className="flex items-center gap-2.5">
            <TriangleAlert size={14} className="shrink-0 text-danger" aria-hidden />
            <span className="min-w-0 flex-1">{error.message}</span>
          </div>
          {error.githubToken && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  closeImport()
                  openSettings('credentials')
                }}
                className="focus-ring shrink-0 rounded font-semibold text-accent hover:underline"
              >
                {t('skills.import.openGithubSettings')}
              </button>
            </div>
          )}
        </div>
      )}
      {scan && !scanning && (
        <>
          <div className="flex items-center justify-between gap-3 px-0.5 pt-1">
            <span className="truncate text-sm font-semibold text-fg">
              {t('skills.import.found', { count: candidates.length, origin: originLabel })}
            </span>
            {importable.length > 1 && (
              <button
                type="button"
                onClick={() =>
                  setSelected(
                    chosen.length === importable.length ? new Set() : new Set(importable.map((c) => c.path)),
                  )
                }
                className="focus-ring shrink-0 rounded text-sm font-semibold text-accent hover:underline"
              >
                {chosen.length === importable.length
                  ? t('skills.import.selectNone')
                  : t('skills.import.selectAll')}
              </button>
            )}
          </div>
          <ul className="flex flex-col overflow-hidden rounded-[10px] border border-border">
            {shown.map((candidate, index) => (
              <CandidateRow
                key={candidate.path}
                candidate={candidate}
                first={index === 0}
                checked={selected.has(candidate.path)}
                onToggle={() => toggle(candidate.path)}
                builtinName={builtinName(candidate)}
                failure={failed.find((f) => f.path === candidate.path) ?? null}
                errorText={errorText}
              />
            ))}
          </ul>
          {candidates.length > SHOWN && (
            <button
              type="button"
              onClick={() => setShowAll(!showAll)}
              className="focus-ring -mt-1.5 w-fit rounded px-0.5 text-xs text-fg-muted hover:text-fg-secondary hover:underline"
            >
              {showAll
                ? t('skills.import.less')
                : t('skills.import.more', { count: candidates.length - SHOWN })}
            </button>
          )}
          {scripts && (
            <Notice icon={<ShieldAlert size={14} className="text-warning" />}>
              {t('skills.import.scriptsNote')}
            </Notice>
          )}
        </>
      )}
      {!scan && !scanning && !error && (
        <div className="flex items-center gap-2 px-0.5 text-xs text-fg-muted">
          <Info size={12} className="shrink-0" aria-hidden />
          {t('skills.import.hint')}
        </div>
      )}
    </Modal>
  )
}
