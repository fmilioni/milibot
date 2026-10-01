import type { SkillImportCommitResult, SkillImportScan, SkillImportSource } from '@milibot/shared'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { defaultSelection, importErrorKey, needsGithubToken } from '@/features/skills/lib/skills'
import { errorMessage, isApiError } from '@/lib/errors'

import { useSkillsStore } from './store'

export interface ScanError {
  message: string
  githubToken: boolean
}

/**
 * The import dialog's scan: `run(source)` lists what a source holds (a newer run wins over an older answer)
 * and preselects what can be imported; dropped `initialPaths` are scanned as soon as the dialog opens.
 */
export function useImportScan(workspaceId: string, initialPaths: string[]) {
  const { t } = useTranslation()
  const scanSource = useSkillsStore((s) => s.scan)
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<ScanError | null>(null)
  const [scan, setScan] = useState<SkillImportScan | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showAll, setShowAll] = useState(false)
  const [failed, setFailed] = useState<SkillImportCommitResult['failed']>([])
  const scanRun = useRef(0)

  const beginScan = () => {
    setScanning(true)
    setError(null)
    setFailed([])
  }
  const scanFor = async (source: SkillImportSource) => {
    const id = ++scanRun.current
    try {
      const result = await scanSource(workspaceId, source)
      if (id !== scanRun.current) return
      setScan(result)
      setSelected(new Set(defaultSelection(result.candidates)))
      setShowAll(false)
    } catch (err) {
      if (id !== scanRun.current) return
      const details = isApiError(err) ? err.details : undefined
      const key = importErrorKey(details)
      setScan(null)
      setError({
        message: key ? t(key as never) : err instanceof Error ? errorMessage(err) : t('toast.error'),
        githubToken: needsGithubToken(details),
      })
    } finally {
      if (id === scanRun.current) setScanning(false)
    }
  }

  const run = (source: SkillImportSource) => {
    beginScan()
    return scanFor(source)
  }

  // Dropped paths open the dialog already scanning them.
  const initialKey = initialPaths.join('\n')
  const [startedKey, setStartedKey] = useState('')
  if (startedKey !== initialKey) {
    setStartedKey(initialKey)
    if (initialKey) beginScan()
  }
  const scanInitial = useEffectEvent((paths: string[]) => void scanFor({ kind: 'paths', paths }))
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- scanFor sets state only after its first await
    if (initialKey) scanInitial(initialKey.split('\n'))
  }, [initialKey])

  return {
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
  }
}
