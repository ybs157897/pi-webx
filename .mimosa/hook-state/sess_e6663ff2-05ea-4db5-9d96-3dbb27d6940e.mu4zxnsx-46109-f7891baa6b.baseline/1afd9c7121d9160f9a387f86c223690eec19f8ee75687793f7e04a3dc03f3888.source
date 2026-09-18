/**
 * Models settings section, ported from dsh's `ui-settings-models`
 * ModelsSection: the provider rows with confirmed API-key state dots, with one
 * editor card open at a time. Rows and cards write through the bridge's
 * `/api/models-config` endpoints; every write answers with the whole file, so
 * the page state is replaced rather than refetched. A provider removal first
 * requires confirmation. When models.json has no provider at all, the create
 * card renders in place of the rows (the first-run posture) until the user
 * closes it.
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ModelConfigResponse, ProviderView } from '../../shared/models-config'
import { Button, IconPlusOutline16, Modal } from '../../ui/primitives/index.ts'
import { errorMessage, modelsConfigApi, sortedProviders } from '../../lib/modelsConfig'
import { providerCopy, t } from './copy.ts'
import { CustomProviderCard } from './CustomProviderCard.tsx'
import { ProviderEditor } from './ProviderEditor.tsx'
import styles from './ModelsSection.module.css'

/** Identity of the provider a card just wrote, for the saved notice. */
interface ProviderIdentity {
  id: string
  name?: string
}

/** Refresh the identity against the config the write answered with. */
function identityOf(config: ModelConfigResponse | undefined, id: string): ProviderIdentity {
  const fresh = config?.providers[id]
  return fresh === undefined
    ? { id }
    : fresh.name === undefined ? { id } : { id, name: fresh.name }
}

/**
 * Render the Models section content column.
 * @returns the section.
 */
export function ModelsSection(): ReactNode {
  const [config, setConfig] = useState<ModelConfigResponse | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ProviderView | undefined>(undefined)
  const [adding, setAdding] = useState(false)
  const [dismissedSetup, setDismissedSetup] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProviderView | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<ProviderIdentity | undefined>(undefined)

  useEffect(() => {
    let stale = false
    void modelsConfigApi.read().then(
      (next) => { if (!stale) setConfig(next) },
      (error) => { if (!stale) setLoadError(errorMessage(error)) },
    ).finally(() => { if (!stale) setLoading(false) })
    return () => { stale = true }
  }, [])

  /** A card closed: clear its seat, adopt the fresh config, announce a write. */
  const closeCard = (
    changed: boolean,
    nextConfig: ModelConfigResponse | undefined,
    target: ProviderIdentity,
  ): void => {
    setEditing(undefined)
    setAdding(false)
    setDismissedSetup(true)
    if (nextConfig !== undefined) setConfig(nextConfig)
    if (changed) setSavedTarget(identityOf(nextConfig, target.id))
  }

  const closeDelete = (): void => {
    if (deleting) return
    setDeleteTarget(undefined)
    setDeleteFailure(undefined)
  }

  const confirmDelete = (): void => {
    /* v8 ignore next -- the action only renders with a target and is disabled while a deletion is pending */
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    setDeleteFailure(undefined)
    void modelsConfigApi.deleteProvider(deleteTarget.id)
      .then((nextConfig) => {
        setConfig(nextConfig)
        setDeleteTarget(undefined)
      })
      .catch((error: unknown) => {
        setDeleteFailure(errorMessage(error))
      })
      .finally(() => { setDeleting(false) })
  }

  if (loadError !== undefined) {
    return (
      <div className={styles['section']}>
        <p className={styles['error']}>{`${t('loadFailed')}：${loadError}`}</p>
        <button
          type="button"
          className={styles['secondaryButton']}
          onClick={() => {
            setLoadError(undefined)
            setLoading(true)
            void modelsConfigApi.read().then(
              (next) => setConfig(next),
              (error) => setLoadError(errorMessage(error)),
            ).finally(() => { setLoading(false) })
          }}
        >
          {t('retry')}
        </button>
      </div>
    )
  }

  const providers = sortedProviders(config)
  const firstRun = config !== undefined && providers.length === 0 && !dismissedSetup
  const savedIdentity = savedTarget === undefined
    ? undefined
    : identityOf(config, savedTarget.id)

  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>
        {config === undefined ? t('intro') : `${t('intro')}（${config.path}）`}
      </p>
      {loading ? <p className={styles['intro']}>正在加载…</p> : null}
      {savedIdentity === undefined
        ? null
        : (
          <p className={styles['savedNotice']} role="status" aria-live="polite">
            {providerCopy(t('savedProvider'), savedIdentity)}
          </p>
        )}
      <ul className={styles['rows']}>
        {providers.map((provider) => {
          const open = !adding && editing?.id === provider.id
          return (
            <li key={provider.id} className={styles['rowCard']}>
              <div className={styles['rowHead']}>
                <span className={styles['rowIdentity']}>
                  <span className={styles['rowName']}>{provider.name ?? provider.id}</span>
                  {provider.apiKey.has
                    ? (
                      <span
                        className={`${styles['credentialDot']} ${styles['credentialDotConfigured']}`}
                        role="img"
                        aria-label={t('credentialConfigured')}
                        title={t('credentialConfigured')}
                      />
                    )
                    : (
                      <span
                        className={`${styles['credentialDot']} ${styles['credentialDotMissing']}`}
                        role="img"
                        aria-label={t('credentialMissing')}
                        title={t('credentialMissing')}
                      />
                    )}
                </span>
                <span className={styles['rowActions']}>
                  <button
                    type="button"
                    className={styles['secondaryButton']}
                    aria-label={providerCopy(t('editProvider'), provider)}
                    onClick={() => {
                      setSavedTarget(undefined)
                      // One card at a time: leaving `adding` set would show the
                      // create card beside this editor, and closing either one
                      // discards the other's draft.
                      setAdding(false)
                      setEditing(open ? undefined : provider)
                    }}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    className={styles['dangerButton']}
                    aria-label={providerCopy(t('removeProvider'), provider)}
                    onClick={() => {
                      setSavedTarget(undefined)
                      setDeleteFailure(undefined)
                      setDeleteTarget(provider)
                    }}
                  >
                    {t('remove')}
                  </button>
                </span>
              </div>
              {open
                ? (
                  <ProviderEditor
                    provider={provider}
                    onClose={(changed, nextConfig) => {
                      closeCard(changed, nextConfig, provider)
                    }}
                  />
                )
                : null}
            </li>
          )
        })}
      </ul>
      <div className={styles['addBlock']}>
        {adding || firstRun
          ? (
            <div className={styles['addCard']}>
              <CustomProviderCard
                taken={providers.map(provider => provider.id)}
                onClose={(changed, nextConfig, createdId) => {
                  closeCard(changed, nextConfig, { id: createdId ?? '' })
                }}
              />
            </div>
          )
          : (
            <div className={styles['addActions']}>
              <button
                type="button"
                className={styles['addButton']}
                onClick={() => {
                  setSavedTarget(undefined)
                  setAdding(true)
                }}
              >
                <IconPlusOutline16 size={14} />
                {t('add')}
              </button>
            </div>
          )}
      </div>
      <Modal
        open={deleteTarget !== undefined}
        onClose={closeDelete}
        title={deleteTarget === undefined ? '' : providerCopy(t('deleteTitle'), deleteTarget)}
        closeLabel={t('close')}
        description={deleteTarget === undefined ? '' : providerCopy(t('deleteDescription'), deleteTarget)}
        className={styles['deleteDialog'] as string}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={deleting} onClick={closeDelete}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={styles['deleteConfirm']}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleteTarget === undefined
                ? ''
                : providerCopy(deleting ? t('deleting') : t('deleteConfirm'), deleteTarget)}
            </Button>
          </>
        )}
      >
        {deleteFailure === undefined ? null : <p className={styles['error']}>{deleteFailure}</p>}
      </Modal>
    </div>
  )
}
