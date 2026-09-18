/**
 * Catalog providers on the settings page — a provider pi ships (or an extension
 * registered), configured through its credential rather than through a
 * `models.json` profile.
 *
 * Ported from deepseek-harness's Models section, whose shape the observation
 * settled:
 *
 *   - the list shows the providers this deployment has, **not** the catalogue.
 *     dsh renders five one-line rows and hides the other thirty behind
 *     `添加提供方`; a wall of unconfigured providers is not the design.
 *   - a row is one line: name, an optional `自定义` tag (owned by
 *     `ModelsSection`, which renders the declared half), a credential dot, and
 *     `编辑` / `删除`. No source sentence, no counts — dsh puts the source on the
 *     dot's own label.
 *   - `添加提供方` opens an inline card: a provider select over the catalogue,
 *     the key field, and a collapsed `自定义设置` area. dsh's key placeholder
 *     there reads "输入 API 密钥，或留空使用环境认证"; ours cannot store an empty
 *     key, so a blank submission says so instead of failing silently.
 *
 * OAuth sign-in is not wired here yet; a provider that only offers it says so.
 */

import { useCallback, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProviderView } from '../../shared/providers'
import { credentialSourceLabel } from '../../shared/providers'
import { errorMessage } from '../../lib/modelsConfig'
import { providersApi } from '../../lib/providers'
import { apiKeyFailure, providerCopy, t } from './copy.ts'
import styles from './ModelsSection.module.css'

/** The write-only key field, shared by the edit and add flows. */
function KeyField({
  provider,
  draft,
  busy,
  failure,
  onChange,
  onCancel,
  onSubmit,
  submitLabel,
}: {
  provider: ProviderView
  draft: string
  busy: boolean
  failure: string | undefined
  onChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
  submitLabel: string
}): ReactNode {
  const keyFailure = apiKeyFailure(draft)
  const stored = provider.storedCredential !== null
  return (
    <>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('keyInput')}</span>
        <input
          className={styles['input']}
          type="password"
          autoComplete="off"
          value={draft}
          placeholder={stored ? t('keyReplacePlaceholder') : t('keyPlaceholder')}
          aria-label={t('keyInput')}
          aria-invalid={keyFailure !== undefined}
          disabled={busy}
          onChange={(event) => { onChange(event.target.value) }}
        />
        {keyFailure === undefined ? null : <p className={styles['error']}>{t(keyFailure)}</p>}
        <p className={styles['advancedHint']}>{t('keyStoredByProviderFlow')}</p>
      </div>
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      <div className={styles['editorActions']}>
        <button type="button" className={styles['secondaryButton']} disabled={busy} onClick={onCancel}>
          {t('cancel')}
        </button>
        <button
          type="button"
          className={styles['primaryButton']}
          disabled={busy || draft.trim().length === 0 || keyFailure !== undefined}
          onClick={onSubmit}
        >
          {busy ? t('applying') : submitLabel}
        </button>
      </div>
    </>
  )
}

/** One configured provider: a selectable line with the dot and its state. */
function ProviderRow({
  provider,
  active,
  onSelect,
}: {
  provider: ProviderView
  active: boolean
  onSelect: () => void
}): ReactNode {
  const stored = provider.storedCredential !== null
  return (
    <li>
      <button
        type="button"
        className={`${styles['listRow']} ${active ? styles['listRowActive'] : ''}`}
        aria-pressed={active}
        onClick={onSelect}
      >
        <span className={styles['rowIdentity']}>
          <span className={styles['rowName']}>{provider.name}</span>
          <span
            className={`${styles['credentialDot']} ${
              provider.status.configured ? styles['credentialDotConfigured'] : styles['credentialDotMissing']
            }`}
            role="img"
            aria-label={credentialSourceLabel(provider.status)}
            title={credentialSourceLabel(provider.status)}
          />
        </span>
        {stored ? <span className={styles['rowTag']}>{t('credentialConfigured')}</span> : null}
      </button>
    </li>
  )
}

/**
 * The right-pane editor for a catalog provider: its credential, write-only,
 * plus the disconnect action when one is stored.
 */
export function CatalogProviderDetail({
  provider,
  onWritten,
}: {
  provider: ProviderView
  onWritten: (providers: ProviderView[]) => void
}): ReactNode {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const writable = provider.methods.apiKey?.interactive === true
  const stored = provider.storedCredential !== null

  const run = useCallback(
    (task: Promise<{ providers: ProviderView[] }>): void => {
      setBusy(true)
      setFailure(undefined)
      void task
        .then((next) => {
          onWritten(next.providers)
          setDraft('')
        })
        .catch((error: unknown) => { setFailure(errorMessage(error)) })
        .finally(() => { setBusy(false) })
    },
    [onWritten],
  )

  return (
    <div className={styles['editor']}>
      <div className={styles['editorHeader']}>
        <span className={styles['editorTitle']}>{provider.name}</span>
        <span className={styles['editorRoute']}>{provider.id}</span>
      </div>
      {writable ? (
        <KeyField
          provider={provider}
          draft={draft}
          busy={busy}
          failure={failure}
          onChange={setDraft}
          onCancel={() => { setDraft('') }}
          onSubmit={() => { run(providersApi.setCredential(provider.id, draft.trim())) }}
          submitLabel={t('apply')}
        />
      ) : (
        <p className={styles['advancedHint']}>
          {provider.methods.oauth !== undefined && provider.methods.apiKey === undefined
            ? t('oauthOnly')
            : t('ambientOnly')}
        </p>
      )}
      {stored && !writable ? null : stored ? (
        <div className={styles['editorActions']}>
          <button
            type="button"
            className={styles['dangerButton']}
            disabled={busy}
            aria-label={providerCopy(t('disconnect'), provider)}
            onClick={() => { run(providersApi.removeCredential(provider.id)) }}
          >
            {t('disconnect')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** `添加提供方`: pick a provider from the catalogue, then give it a key. */
export function AddProviderCard({
  providers,
  onWritten,
  onClose,
}: {
  providers: readonly ProviderView[]
  onWritten: (providers: ProviderView[]) => void
  onClose: () => void
}): ReactNode {
  // The catalogue, not just the unconfigured slice: replacing an existing key
  // through the same flow is what dsh's select allows.
  const options = useMemo(
    () => providers.filter((provider) => provider.declared === false),
    [providers],
  )
  const [selected, setSelected] = useState<string>('')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  // Nothing chosen yet: open on the first provider that still needs a key,
  // falling back to the head of the list on a fully configured deployment.
  const target = useMemo(() => {
    if (selected.length > 0) return options.find((provider) => provider.id === selected)
    return options.find((provider) => !provider.status.configured) ?? options[0]
  }, [options, selected])

  const keyFailure = apiKeyFailure(draft)
  const cannotStore = target !== undefined && target.methods.apiKey?.interactive !== true

  const submit = useCallback((): void => {
    if (target === undefined) return
    setBusy(true)
    setFailure(undefined)
    void providersApi
      .setCredential(target.id, draft.trim())
      .then((next) => {
        onWritten(next.providers)
        onClose()
      })
      .catch((error: unknown) => { setFailure(errorMessage(error)) })
      .finally(() => { setBusy(false) })
  }, [draft, onClose, onWritten, target])

  return (
    <div className={styles['addCard']}>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('provider')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={target?.id ?? ''}
          aria-label={t('provider')}
          disabled={busy}
          onChange={(event) => { setSelected(event.target.value) }}
        >
          {options.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name === provider.id ? provider.id : `${provider.name}（${provider.id}）`}
            </option>
          ))}
        </select>
      </div>
      {target === undefined ? null : cannotStore ? (
        <p className={styles['advancedHint']}>{t('ambientOnly')}</p>
      ) : (
        <KeyField
          provider={target}
          draft={draft}
          busy={busy}
          failure={failure}
          onChange={setDraft}
          onCancel={onClose}
          onSubmit={submit}
          submitLabel={t('apply')}
        />
      )}
      {target !== undefined && cannotStore ? (
        <div className={styles['editorActions']}>
          <button type="button" className={styles['secondaryButton']} disabled={busy} onClick={onClose}>
            {t('cancel')}
          </button>
        </div>
      ) : null}
      {keyFailure === undefined ? null : null}
    </div>
  )
}

/**
 * The configured catalog providers — one selectable row each.
 *
 * Presentational by contract: `ModelsSection` owns the list and the selection
 * because the add flow writes to the same providers, and the pane beside the
 * list renders whichever entry is chosen.
 *
 * @param props - the provider list, the current selection, and the callback
 *   that moves the selection.
 * @returns the rows, or an error line; the declared providers stay usable either
 *   way, so a failed read is reported rather than thrown.
 */
export function CatalogProviders({
  providers,
  loadError,
  activeId,
  onSelect,
}: {
  providers: readonly ProviderView[] | undefined
  loadError: string | undefined
  activeId: string | undefined
  onSelect: (id: string) => void
}): ReactNode {
  const rows = (providers ?? []).filter(
    (provider) => provider.declared === false && provider.status.configured,
  )

  return (
    <>
      {loadError === undefined ? null : (
        <p className={styles['error']}>{`${t('loadFailed')}：${loadError}`}</p>
      )}
      <ul className={styles['list']}>
        {rows.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            active={provider.id === activeId}
            onSelect={() => { onSelect(provider.id) }}
          />
        ))}
      </ul>
    </>
  )
}
