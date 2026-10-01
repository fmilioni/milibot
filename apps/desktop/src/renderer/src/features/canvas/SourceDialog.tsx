import type { DesignFrame } from '@milibot/shared'
import { Check, Code2, Copy } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso } from 'react-virtuoso'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { getDesignFrameSource } from '@/features/canvas/api'
import { useCopyFlash } from '@/hooks/use-copy-flash'
import { AsyncView } from '@/ui/AsyncView'
import { Code } from '@/ui/diff/DiffViewer'
import { Modal } from '@/ui/Modal'
import { Segmented } from '@/ui/Segmented'

type Tab = 'source' | 'tokens'

/** "View frame HTML": the frame as the bot wrote it and the design's tokens.css, read-only. */
export function SourceDialog({
  workspaceId,
  designId,
  frame,
  onClose,
}: {
  workspaceId: string
  designId: string
  frame: DesignFrame
  onClose: () => void
}) {
  const { t } = useTranslation()
  const {
    data: source,
    error,
    reload,
  } = useApiQuery(queryKeys.designFrameSource(workspaceId, designId, frame.id), () =>
    getDesignFrameSource(workspaceId, designId, frame.id),
  )
  const [tab, setTab] = useState<Tab>('source')
  const [copied, copy] = useCopyFlash()

  const text = source ? (tab === 'source' ? source.source : source.tokensCss) : ''
  const lines = useMemo(() => text.split('\n'), [text])

  return (
    <Modal
      title={t('canvas.source.title', { name: frame.name })}
      description={t('canvas.source.description')}
      width={780}
      onClose={onClose}
      closeLabel={t('common.close')}
      icon={<Code2 size={16} />}
    >
      <div className="relative">
        <Segmented
          value={tab}
          options={[
            { value: 'source', label: t('canvas.source.frame') },
            { value: 'tokens', label: 'tokens.css' },
          ]}
          onChange={setTab}
          label={t('canvas.source.title', { name: frame.name })}
          variant="underline"
          role="tab"
        />
        <button
          type="button"
          disabled={!source}
          onClick={() => copy(text)}
          className="focus-ring absolute top-1 right-0 flex h-7 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-fg-secondary hover:bg-surface-3 disabled:opacity-40"
        >
          {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          {copied ? t('canvas.source.copied') : t('canvas.source.copy')}
        </button>
      </div>
      <div className="flex h-[min(520px,60vh)] flex-col overflow-hidden rounded-lg border border-border bg-surface">
        <AsyncView
          data={source}
          error={error}
          errorText={t('canvas.source.failed')}
          onRetry={reload}
          className="flex flex-1 items-center justify-center text-base text-fg-muted"
        >
          {() => (
            <Virtuoso
              className="scroll-slim min-h-0 flex-1 py-2 font-mono text-sm leading-[19px]"
              data={lines}
              itemContent={(i, line) => (
                <div className="flex">
                  <span className="w-11 shrink-0 pr-3 text-right text-fg-muted/80 select-none">{i + 1}</span>
                  <span className="code-tokens selectable min-w-0 flex-1 pr-3 whitespace-pre-wrap [overflow-wrap:anywhere]">
                    <Code text={line} language={tab === 'source' ? 'markup' : 'css'} />
                  </span>
                </div>
              )}
            />
          )}
        </AsyncView>
      </div>
    </Modal>
  )
}
