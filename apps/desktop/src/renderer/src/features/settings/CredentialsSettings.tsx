import { Copy, Plus } from 'lucide-react'
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { GithubToken } from '@/features/settings/credentials/GithubToken'
import { SecretForm, SecretRow } from '@/features/settings/credentials/Secrets'
import { WebSearchKey } from '@/features/settings/credentials/WebSearchKey'
import { copyWithToast } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { useDraft } from '@/hooks/use-draft'
import { Button, LinkButton } from '@/ui/Button'
import { Switch } from '@/ui/Switch'

import { getGithub, getSshKey, getWebSearch, listEnvSecrets } from './api'
import { KeyringNotice } from './HostWarnings'
import { SettingsCard, SettingsPage, SettingsRow } from './SettingsLayout'
import { useWorkspacePreferences } from './store'

function TemplateInput({
  value,
  onSave,
  label,
}: {
  value: string
  onSave: (value: string) => void
  label: string
}) {
  const [draft, setDraft] = useDraft(value)
  return (
    <input
      aria-label={label}
      value={draft}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() && draft.trim() !== value) onSave(draft.trim())
        else setDraft(value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      className="selectable h-[28px] w-[240px] rounded-[7px] border border-transparent bg-transparent px-2 text-right font-mono text-sm text-fg-secondary outline-none hover:border-border focus:border-accent focus:text-fg"
    />
  )
}

export function CredentialsSettings() {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const { prefs, loaded, set } = useWorkspacePreferences(workspaceId)
  const github = useApiQuery(queryKeys.credentials(workspaceId, 'github'), () => getGithub(workspaceId))
  const webSearch = useApiQuery(queryKeys.credentials(workspaceId, 'web-search'), () =>
    getWebSearch(workspaceId),
  )
  const secrets = useApiQuery(queryKeys.credentials(workspaceId, 'secrets'), () =>
    listEnvSecrets(workspaceId),
  )
  const ssh = useApiQuery(queryKeys.credentials(workspaceId, 'ssh'), () => getSshKey(workspaceId)).data
  const [form, setForm] = useState<{ secretId: string | null } | null>(null)

  return (
    <SettingsPage title={t('settings.sections.credentials')} subtitle={t('settings.credentials.subtitle')}>
      <KeyringNotice />
      <SettingsCard title={t('settings.credentials.github.title')}>
        <GithubToken status={github.data} />
        <SettingsRow
          label={t('settings.credentials.github.commitName')}
          hint={t('settings.credentials.github.commitNameHint')}
        >
          <TemplateInput
            label={t('settings.credentials.github.commitName')}
            value={prefs.commitName}
            onSave={(commitName) => void set({ commitName })}
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.credentials.github.commitEmail')}
          hint={t('settings.credentials.github.commitEmailHint')}
        >
          <TemplateInput
            label={t('settings.credentials.github.commitEmail')}
            value={prefs.commitEmail}
            onSave={(commitEmail) => void set({ commitEmail })}
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.credentials.github.draftPrs')}
          hint={t('settings.credentials.github.draftPrsHint')}
        >
          <Switch
            checked={prefs.draftPrs}
            disabled={!loaded}
            label={t('settings.credentials.github.draftPrs')}
            onChange={(draftPrs) => void set({ draftPrs })}
          />
        </SettingsRow>
        <SettingsRow
          label={t('settings.credentials.github.autoMergePrs')}
          hint={t('settings.credentials.github.autoMergePrsHint')}
        >
          <Switch
            checked={prefs.autoMergePrs}
            disabled={!loaded}
            label={t('settings.credentials.github.autoMergePrs')}
            onChange={(autoMergePrs) => void set({ autoMergePrs })}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title={t('settings.credentials.webSearch.title')}>
        <WebSearchKey status={webSearch.data} />
      </SettingsCard>

      <SettingsCard title={t('settings.credentials.secrets.title')}>
        <div className="flex flex-col gap-2 px-4 pt-1 pb-3.5">
          <ul className="flex flex-col gap-1.5">
            {secrets.data?.map((secret) => (
              <Fragment key={secret.id}>
                <SecretRow
                  secret={secret}
                  editing={form?.secretId === secret.id}
                  onEdit={() => setForm({ secretId: secret.id })}
                />
                {form?.secretId === secret.id && (
                  <li>
                    <SecretForm secret={secret} onClose={() => setForm(null)} onSaved={() => setForm(null)} />
                  </li>
                )}
              </Fragment>
            ))}
          </ul>
          {form?.secretId === null ? (
            <SecretForm onClose={() => setForm(null)} onSaved={() => setForm(null)} />
          ) : (
            <LinkButton
              onClick={() => setForm({ secretId: null })}
              className="inline-flex w-fit items-center gap-1.5"
            >
              <Plus size={13} />
              {t('settings.credentials.secrets.add')}
            </LinkButton>
          )}
          <p className="text-xs leading-[15px] text-fg-muted">{t('settings.credentials.secrets.note')}</p>
        </div>
      </SettingsCard>

      <SettingsCard title={t('settings.credentials.ssh.title')}>
        <SettingsRow
          label={t('settings.credentials.ssh.publicKey')}
          hint={
            ssh?.publicKey ? (
              <span className="selectable block truncate font-mono">
                {ssh.publicKey.length > 72
                  ? `${ssh.publicKey.slice(0, 36)}…${ssh.publicKey.slice(-28)}`
                  : ssh.publicKey}
                {' — '}
                {t('settings.credentials.ssh.hint')}
              </span>
            ) : ssh && !ssh.vmRunning ? (
              t('settings.credentials.ssh.vmOff')
            ) : (
              t('common.loading')
            )
          }
        >
          <Button size="sm" disabled={!ssh?.publicKey} onClick={() => copyWithToast(ssh?.publicKey ?? '')}>
            <Copy size={12} />
            {t('settings.credentials.ssh.copy')}
          </Button>
        </SettingsRow>
      </SettingsCard>
    </SettingsPage>
  )
}
