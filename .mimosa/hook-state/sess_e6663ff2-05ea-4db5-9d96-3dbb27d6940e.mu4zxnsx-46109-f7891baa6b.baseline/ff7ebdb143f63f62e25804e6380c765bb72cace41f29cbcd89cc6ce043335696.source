/**
 * The card that adds a provider models.json does not have yet — an
 * OpenAI-compatible gateway, a self-hosted server, or a provider newer than
 * the installed catalog. Ported from dsh's CustomProviderCard.
 *
 * This is a create, not an edit, which is why it is its own card rather than
 * the provider editor with extra fields: the provider id is being *chosen*
 * here, and the settings entry does not exist until it is. One upsert writes
 * the whole profile; the key travels inside the same write, exactly as an
 * existing provider's key does.
 *
 * The fields a new provider cannot default — id, endpoint, protocol, and at
 * least one model — are required here rather than at load, so the failure
 * names the field while the user is still looking at it.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ModelConfigResponse, PiApiKind } from '../../shared/models-config'
import { PI_API_KINDS } from '../../shared/models-config'
import {
  PI_API_KIND_LABELS,
  errorMessage,
  httpUrlError,
  modelsConfigApi,
  providerIdError,
} from '../../lib/modelsConfig'
import { validateModels } from './capacity.ts'
import type { ModelDraft } from './capacity.ts'
import { apiKeyFailure, t } from './copy.ts'
import { EditorFooter } from './EditorFooter.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import styles from './ModelsSection.module.css'

/** Props of {@link CustomProviderCard}. */
export interface CustomProviderCardProps {
  /** Provider ids already taken, so the card refuses to shadow one. */
  taken: readonly string[]
  /**
   * Close the card. `changed` reports whether a provider was created;
   * `config` is the fresh whole-file response the write answered with;
   * `createdId` names the route that was created, for the saved notice.
   */
  onClose: (changed: boolean, config?: ModelConfigResponse, createdId?: string) => void
}

/**
 * Render the custom-provider creation card.
 * @param props - existing ids plus the close contract.
 * @returns the creation card.
 */
export function CustomProviderCard(props: CustomProviderCardProps): ReactNode {
  const [route, setRoute] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [api, setApi] = useState<PiApiKind>(() => PI_API_KINDS[0] ?? 'openai-completions')
  const [keyDraft, setKeyDraft] = useState('')
  const [models, setModels] = useState<readonly ModelDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const disabled = busy

  const routeFailure = route.length > 0 ? providerIdError(route) : undefined
  const routeTaken = props.taken.includes(route)
  const normalizedBaseUrl = baseUrl.trim()
  const baseUrlFailure = baseUrl.length > 0 ? httpUrlError(normalizedBaseUrl) : undefined
  const modelFailure = validateModels(models)
  const keyFailure = apiKeyFailure(keyDraft)
  const keyValue = keyDraft.trim()
  const ready = route.length > 0 && routeFailure === undefined && !routeTaken
    && normalizedBaseUrl.length > 0 && baseUrlFailure === undefined
    && models.length > 0 && modelFailure === undefined
    && keyFailure === undefined
  // The one blocked gate worth a line under the form. A satisfied card says
  // nothing at all rather than printing an empty paragraph.
  const hint = failure !== undefined || ready
    // The key and route fields print their own failures directly beneath
    // themselves, so a card blocked only by either stays silent here rather
    // than answering with the next unmet gate — which is satisfied, and reads
    // as a second, false fault.
    || keyFailure !== undefined
    || route.length === 0 || routeFailure !== undefined || routeTaken || baseUrlFailure !== undefined
      ? undefined
      : normalizedBaseUrl.length === 0
        ? t('customNeedsBaseUrl')
        : modelFailure !== undefined
          ? `${t('model')} ${String(modelFailure.index + 1)}：${t(modelFailure.key)}`
          : t('customNeedsModels')

  const create = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const config = await modelsConfigApi.upsertProvider(route, {
        ...(displayName.trim().length > 0 ? { name: displayName.trim() } : {}),
        baseUrl: normalizedBaseUrl,
        api,
        ...keyValue.length > 0 ? { apiKey: { value: keyValue } } : {},
        models: models.map(model => ({ ...model })),
      })
      props.onClose(true, config, route)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles['editor']}>
      <div className={styles['editorHeader']}>
        <span className={styles['editorTitle']}>{t('customTitle')}</span>
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('customRoute')}</span>
        <input
          className={styles['input']}
          type="text"
          value={route}
          placeholder="acme-gateway"
          aria-label={t('customRoute')}
          disabled={disabled}
          onChange={(event) => { setRoute(event.target.value) }}
        />
      </div>
      {/* A rejected id reads as a fault, not as guidance — the same split the
          key field below already makes between its failure and its hint. */}
      {routeFailure !== undefined || routeTaken
        ? <p className={styles['error']}>{routeFailure ?? t('customRouteTaken')}</p>
        : <p className={styles['advancedHint']}>{t('customRouteHint')}</p>}
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('customDisplayName')}</span>
        <input
          className={styles['input']}
          type="text"
          value={displayName}
          placeholder={route.length === 0 ? t('customDisplayName') : route}
          aria-label={t('customDisplayName')}
          disabled={disabled}
          onChange={(event) => { setDisplayName(event.target.value) }}
        />
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
        <input
          className={styles['input']}
          type="text"
          value={baseUrl}
          placeholder={t('customBaseUrlPlaceholder')}
          aria-label={t('baseUrl')}
          aria-invalid={baseUrlFailure !== undefined}
          disabled={disabled}
          onChange={(event) => { setBaseUrl(event.target.value) }}
        />
        {baseUrlFailure === undefined ? null : <p className={styles['error']}>{baseUrlFailure}</p>}
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('customApi')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={api}
          aria-label={t('customApi')}
          disabled={disabled}
          onChange={(event) => { setApi(event.target.value as PiApiKind) }}
        >
          {PI_API_KINDS.map(kind => <option key={kind} value={kind}>{PI_API_KIND_LABELS[kind]}</option>)}
        </select>
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('keyInput')}</span>
        <input
          className={styles['input']}
          type="password"
          autoComplete="off"
          value={keyDraft}
          placeholder={t('keyPlaceholder')}
          aria-label={t('keyInput')}
          disabled={disabled}
          onChange={(event) => { setKeyDraft(event.target.value) }}
        />
        {/* A create card has no stored key to keep, so the blank case says
            what a blank field means here instead: the endpoint may be public
            or authenticate some other way. */}
        {keyFailure === undefined ? null : <p className={styles['error']}>{t(keyFailure)}</p>}
      </div>
      <ModelListEditor
        models={models}
        onChange={setModels}
        probe={{
          ...(normalizedBaseUrl.length > 0 ? { baseUrl: normalizedBaseUrl } : {}),
          ...(keyValue.length > 0 ? { apiKey: keyValue } : {}),
        }}
        probeBlocked={baseUrlFailure !== undefined
          ? baseUrlFailure
          : keyFailure !== undefined ? t(keyFailure) : undefined}
        disabled={disabled}
      />
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      {/* Only the gates with something to say render; the route-id gate has its
          own field-level hint, so its blocked state would print an empty line. */}
      {hint === undefined ? null : <p className={styles['advancedHint']}>{hint}</p>}
      <EditorFooter
        busy={busy}
        submitDisabled={disabled || !ready}
        submitLabel={t('create')}
        submitBusyLabel={t('creating')}
        cancelLabel={t('cancel')}
        onCancel={() => { props.onClose(false) }}
        onSubmit={() => { void create() }}
      />
    </div>
  )
}
