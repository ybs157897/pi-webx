/**
 * Models settings section — the reference's provider list + detail pane.
 *
 * One list on the left, split by ownership (内置目录 / 自定义), one pane on the
 * right: a catalog provider shows its credential editor, a declared provider
 * shows {@link ProviderEditor} with its model rows, and the add flows open in
 * the same pane so nothing ever renders as a stack of inline cards. Every
 * write answers with the whole file, so the page state is replaced rather than
 * refetched; a provider removal still requires confirmation.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ModelConfigResponse, ProviderView } from '../../shared/models-config'
import {
  Button,
  IconPlusOutline16,
  IconRefreshOutline16,
  Modal,
} from '../../ui/primitives/index.ts'
import { errorMessage, modelsConfigApi, sortedProviders } from '../../lib/modelsConfig'
import {
  AddProviderCard,
  CatalogProviderDetail,
  CatalogProviders,
} from './CatalogProviders.tsx'
import { providersApi } from '../../lib/providers'
import type { ProviderView as CatalogProviderView } from '../../shared/providers'
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
  const [dismissedSetup, setDismissedSetup] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ProviderView | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)
  const [savedTarget, setSavedTarget] = useState<ProviderIdentity | undefined>(undefined)
  /** The catalog half of the list; owned here because both add flows write to it. */
  const [catalogProviders, setCatalogProviders] = useState<CatalogProviderView[] | undefined>(undefined)
  const [catalogError, setCatalogError] = useState<string | undefined>(undefined)
  /** `'catalog'` opens 添加提供方, `'custom'` opens 添加自定义提供方, `undefined` neither. */
  const [addFlow, setAddFlow] = useState<'catalog' | 'custom' | undefined>(undefined)
  /** Which detail the pane shows; defaults to the first declared provider. */
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  /** Same, for the catalog half (`undefined` = follow the default). */
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | undefined>(undefined)

  /** Read both halves of the list: the declared providers and the catalog. */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    await Promise.all([
      modelsConfigApi.read().then(
        (next) => { setConfig(next); setLoadError(undefined) },
        (error: unknown) => { setLoadError(errorMessage(error)) },
      ),
      providersApi.list().then(
        (next) => { setCatalogProviders(next.providers); setCatalogError(undefined) },
        (error: unknown) => { setCatalogError(errorMessage(error)) },
      ),
    ])
    setLoading(false)
  }, [])

  useEffect(() => { void load() }, [load])

  /** A card closed: adopt the fresh config and announce a write. */
  const [editorVersion, setEditorVersion] = useState(0)

  const closeCard = (
    changed: boolean,
    nextConfig: ModelConfigResponse | undefined,
    target: ProviderIdentity,
  ): void => {
    setEditorVersion(version => version + 1)
    setAddFlow(undefined)
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
    const id = deleteTarget.id
    setDeleting(true)
    setDeleteFailure(undefined)
    void modelsConfigApi.deleteProvider(id)
      .then((nextConfig) => {
        setConfig(nextConfig)
        setDeleteTarget(undefined)
        setSelectedId(current => (current === id ? undefined : current))
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
        <button type="button" className={styles['secondaryButton']} onClick={() => void load()}>
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

  // The pane always shows something: the explicit pick, else the first declared
  // provider, else the first configured catalog provider.
  const catalogRows = (catalogProviders ?? []).filter(
    provider => provider.declared === false && provider.status.configured,
  )
  const activeCustom = providers.find(provider => provider.id === selectedId) ?? providers[0]
  const activeCatalog = catalogRows.find(provider => provider.id === selectedCatalogId) ?? catalogRows[0]

  const pane = ((): ReactNode => {
    if (addFlow === 'catalog') {
      return (
        <div className={styles['addCard']}>
          <AddProviderCard
            providers={catalogProviders ?? []}
            onWritten={setCatalogProviders}
            onClose={() => { setAddFlow(undefined) }}
          />
        </div>
      )
    }
    if (addFlow === 'custom' || firstRun) {
      return (
        <div className={styles['addCard']}>
          <CustomProviderCard
            taken={providers.map(provider => provider.id)}
            onClose={(changed, nextConfig, createdId) => {
              closeCard(changed, nextConfig, { id: createdId ?? '' })
              setAddFlow(undefined)
            }}
          />
        </div>
      )
    }
    // The explicit selection wins over the default: picking a catalog provider
    // must not keep showing the first declared one.
    const wantsCatalog = selectedCatalogId !== undefined || selectedId === undefined
    if (wantsCatalog && activeCatalog !== undefined) {
      return (
        <CatalogProviderDetail
          key={activeCatalog.id}
          provider={activeCatalog}
          onWritten={setCatalogProviders}
        />
      )
    }
    if (activeCustom !== undefined) {
      return (
        <ProviderEditor
          key={`${activeCustom.id}:${editorVersion}`}
          provider={activeCustom}
          onClose={(changed, nextConfig) => {
            closeCard(changed, nextConfig, activeCustom)
          }}
          onRequestDelete={() => {
            setSavedTarget(undefined)
            setDeleteFailure(undefined)
            setDeleteTarget(activeCustom)
          }}
        />
      )
    }
    return <p className={styles['emptyHint']}>{t('selectProviderHint')}</p>
  })()

  return (
    <div className={styles['section']}>
      <div className={styles['lead']}>
        <p className={styles['intro']}>{t('intro')}</p>
        <div className={styles['leadActions']}>
          <button
            type="button"
            className={styles['iconButton']}
            aria-label={t('refresh')}
            title={t('refresh')}
            disabled={loading}
            onClick={() => void load()}
          >
            <IconRefreshOutline16 size={14} />
          </button>
          <button
            type="button"
            className={styles['primaryButton']}
            onClick={() => {
              setSavedTarget(undefined)
              setAddFlow('catalog')
            }}
          >
            <IconPlusOutline16 size={14} />
            {t('add')}
          </button>
        </div>
      </div>
      {loading ? <p className={styles['intro']}>{t('loading')}</p> : null}
      {savedIdentity === undefined
        ? null
        : (
          <p className={styles['savedNotice']} role="status" aria-live="polite">
            {providerCopy(t('savedProvider'), savedIdentity)}
          </p>
        )}

      <div className={styles['panes']}>
        <aside className={styles['listPane']} aria-label={t('providerList')}>
          {catalogRows.length > 0 || catalogError !== undefined ? (
            <div className={styles['listGroup']}>
              <div className={styles['listGroupHead']}>
                <span className={styles['listGroupLabel']}>{t('groupCatalog')}</span>
              </div>
              <CatalogProviders
                providers={catalogProviders}
                loadError={catalogError}
                activeId={activeCatalog?.id}
                onSelect={(id) => {
                  setAddFlow(undefined)
                  setSelectedCatalogId(id)
                  setSelectedId(undefined)
                }}
              />
            </div>
          ) : null}
          <div className={styles['listGroup']}>
            <div className={styles['listGroupHead']}>
              <span className={styles['listGroupLabel']}>{t('groupCustom')}</span>
              <button
                type="button"
                className={styles['iconButton']}
                aria-label={t('addCustom')}
                title={t('addCustom')}
                onClick={() => {
                  setSavedTarget(undefined)
                  setAddFlow('custom')
                }}
              >
                <IconPlusOutline16 size={14} />
              </button>
            </div>
          <ul className={styles['list']}>
            {providers.map((provider) => (
              <li key={provider.id}>
                <button
                  type="button"
                  className={`${styles['listRow']} ${
                    provider.id === activeCustom?.id && selectedCatalogId === undefined
                      ? styles['listRowActive']
                      : ''
                  }`}
                  aria-pressed={provider.id === activeCustom?.id}
                  onClick={() => {
                    setAddFlow(undefined)
                    setSavedTarget(undefined)
                    setSelectedId(provider.id)
                    setSelectedCatalogId(undefined)
                  }}
                >
                  <span className={styles['rowIdentity']}>
                    <span className={styles['rowName']}>{provider.name ?? provider.id}</span>
                    <span className={styles['rowTag']}>{t('customTag')}</span>
                    <span
                      className={`${styles['credentialDot']} ${
                        provider.apiKey.has
                          ? styles['credentialDotConfigured']
                          : styles['credentialDotMissing']
                      }`}
                      role="img"
                      aria-label={provider.apiKey.has ? t('credentialConfigured') : t('credentialMissing')}
                      title={provider.apiKey.has ? t('credentialConfigured') : t('credentialMissing')}
                    />
                  </span>
                  {provider.piWebx?.enabled === false
                    ? <span className={styles['rowTag']}>{t('modelDisabled')}</span>
                    : null}
                </button>
              </li>
            ))}
          </ul>
          </div>
        </aside>
        <div className={styles['detailPane']}>{pane}</div>
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
