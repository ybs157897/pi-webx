/**
 * One provider's editor card, ported from dsh's `ui-settings-models`
 * ProviderEditor (pi-ai family): the primary field is a single write-only
 * **API key** input — a blank key keeps whatever is configured, which is what
 * makes saving a redacted view safe — and the collapsed 自定义设置 area carries
 * the display name, Base URL, wire protocol, auth-header mode, and the model
 * catalog. The whole form is the desired state: a field sent as '' clears it,
 * and the model list is written as one array.
 *
 * Reasoning effort is deliberately absent: it is a per-MODEL capability, and
 * the models under one provider disagree about it, so a provider-scoped
 * control can only be set to a value some of them reject.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type {
  ModelConfigResponse,
  PiApiKind,
  ProviderView,
} from '../../shared/models-config'
import { PI_API_KINDS } from '../../shared/models-config'
import {
  PI_API_KIND_LABELS,
  apiKeySummary,
  errorMessage,
  httpUrlError,
  modelsConfigApi,
} from '../../lib/modelsConfig'
import { modelDrafts, validateModels } from './capacity.ts'
import type { ModelDraft } from './capacity.ts'
import { apiKeyFailure, t } from './copy.ts'
import { EditorFooter } from './EditorFooter.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import styles from './ModelsSection.module.css'

/** Props of {@link ProviderEditor}. */
export interface ProviderEditorProps {
  /** The stored provider view this card edits. */
  provider: ProviderView
  /** Hide the title row (the section renders its own heading above). */
  hideTitle?: boolean
  /**
   * Close the card. `changed` reports whether a write committed; `config` is
   * the fresh whole-file response every write answers with, so the owner can
   * replace its state without a refetch.
   */
  onClose: (changed: boolean, config?: ModelConfigResponse) => void
}

/**
 * Render one provider's editing card.
 * @param props - the stored view plus the close contract.
 * @returns the editor card.
 */
export function ProviderEditor(props: ProviderEditorProps): ReactNode {
  const { provider } = props
  const [nameDraft, setNameDraft] = useState(provider.name ?? '')
  const [baseUrlDraft, setBaseUrlDraft] = useState(provider.baseUrl ?? '')
  const [apiDraft, setApiDraft] = useState<PiApiKind | ''>(provider.api ?? '')
  const [authHeaderDraft, setAuthHeaderDraft] = useState(provider.authHeader === true)
  const [keyDraft, setKeyDraft] = useState('')
  const [removeKey, setRemoveKey] = useState(false)
  const [models, setModels] = useState<readonly ModelDraft[]>(() => modelDrafts(provider.models))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const modelFailure = validateModels(models)
  const keyFailure = apiKeyFailure(keyDraft)
  // What a probe or a write must carry: the typed key with paste whitespace
  // removed. A blank field yields an empty string, which both call sites read
  // as "no key supplied" rather than as a key — that is how a card whose
  // provider already has a stored key is edited without re-entering it.
  const keyValue = keyDraft.trim()
  const baseUrlFailure = baseUrlDraft.trim().length > 0 ? httpUrlError(baseUrlDraft.trim()) : undefined
  const disabled = busy
  const keyPlaceholder = provider.apiKey.has
    ? apiKeySummary(provider.apiKey)
    : t('keyPlaceholder')

  const apply = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const config = await modelsConfigApi.upsertProvider(provider.id, {
        name: nameDraft,
        baseUrl: baseUrlDraft,
        api: apiDraft,
        authHeader: authHeaderDraft,
        ...keyValue.length > 0
          ? { apiKey: { value: keyValue } }
          : removeKey
            ? { apiKey: { remove: true } }
            : {},
        models: models.map(model => ({ ...model })),
      })
      props.onClose(true, config)
    } catch (error) {
      setFailure(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles['editor']}>
      {props.hideTitle === true
        ? null
        : (
          <div className={styles['editorHeader']}>
            <span className={styles['editorTitle']}>{provider.name ?? provider.id}</span>
            {provider.name !== undefined && provider.name !== provider.id
              ? <span className={styles['editorRoute']}>{provider.id}</span>
              : null}
          </div>
        )}
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('keyInput')}</span>
        <input
          className={styles['input']}
          type="password"
          autoComplete="off"
          value={keyDraft}
          placeholder={keyPlaceholder}
          aria-label={t('keyInput')}
          aria-invalid={keyFailure !== undefined}
          disabled={disabled}
          onChange={(event) => { setKeyDraft(event.target.value) }}
        />
        {keyFailure === undefined ? null : <p className={styles['error']}>{t(keyFailure)}</p>}
        {provider.apiKey.source === 'literal'
          ? (
            removeKey
              ? (
                <p className={styles['advancedHint']}>
                  保存后将清除已存储的密钥
                  <button
                    type="button"
                    className={styles['linkButton']}
                    disabled={disabled}
                    onClick={() => { setRemoveKey(false) }}
                  >
                    撤销
                  </button>
                </p>
              )
              : (
                <button
                  type="button"
                  className={styles['linkButton']}
                  disabled={disabled || keyValue.length > 0}
                  onClick={() => { setRemoveKey(true) }}
                >
                  {t('clearStoredKey')}
                </button>
              )
          )
          : null}
      </div>
      <details className={styles['customized']}>
        <summary className={styles['customizedSummary']}>{t('customized')}</summary>
        <div className={styles['customizedBody']}>
          <div className={styles['field']}>
            <span className={styles['fieldLabel']}>{t('customDisplayName')}</span>
            <input
              className={styles['input']}
              type="text"
              value={nameDraft}
              placeholder={provider.id}
              aria-label={t('customDisplayName')}
              disabled={disabled}
              onChange={(event) => { setNameDraft(event.target.value) }}
            />
          </div>
          <div className={styles['field']}>
            <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
            <input
              className={styles['input']}
              type="text"
              value={baseUrlDraft}
              placeholder={provider.baseUrl ?? t('baseUrlDefault')}
              aria-label={t('baseUrl')}
              aria-invalid={baseUrlFailure !== undefined}
              disabled={disabled}
              onChange={(event) => { setBaseUrlDraft(event.target.value) }}
            />
            {baseUrlFailure === undefined ? null : <p className={styles['error']}>{baseUrlFailure}</p>}
          </div>
          <div className={styles['field']}>
            <span className={styles['fieldLabel']}>{t('customApi')}</span>
            <select
              className={`${styles['input']} ${styles['selectInput']}`}
              value={apiDraft}
              aria-label={t('customApi')}
              disabled={disabled}
              onChange={(event) => { setApiDraft(event.target.value as PiApiKind | '') }}
            >
              {/* A profile naming no protocol — hand-written into models.json
                  with no model to need one — selects nothing rather than
                  reading as if it had picked the first choice. Clearing back
                  to it is offered only when nothing was stored. */}
              {apiDraft === '' && provider.api === undefined
                ? <option value="">{t('customApiUnset')}</option>
                : null}
              {PI_API_KINDS.map(kind => <option key={kind} value={kind}>{PI_API_KIND_LABELS[kind]}</option>)}
            </select>
          </div>
          <div className={styles['field']}>
            <span className={styles['fieldLabel']}>{t('authHeader')}</span>
            <select
              className={`${styles['input']} ${styles['selectInput']}`}
              value={authHeaderDraft ? 'force' : 'default'}
              aria-label={t('authHeader')}
              disabled={disabled}
              onChange={(event) => { setAuthHeaderDraft(event.target.value === 'force') }}
            >
              <option value="default">{t('authHeaderDefault')}</option>
              <option value="force">{t('authHeaderForce')}</option>
            </select>
          </div>
          <ModelListEditor
            models={models}
            onChange={setModels}
            probe={{
              providerId: provider.id,
              ...(baseUrlDraft.trim().length > 0 ? { baseUrl: baseUrlDraft.trim() } : {}),
              ...(keyValue.length > 0 ? { apiKey: keyValue } : {}),
            }}
            probeBlocked={keyFailure !== undefined
              ? t(keyFailure)
              : baseUrlFailure}
            disabled={disabled}
          />
        </div>
      </details>
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      {modelFailure === undefined
        ? null
        : (
          <p className={styles['advancedHint']}>
            {`${t('model')} ${String(modelFailure.index + 1)}：${t(modelFailure.key)}`}
          </p>
        )}
      <EditorFooter
        busy={busy}
        submitDisabled={disabled
          || keyFailure !== undefined
          || modelFailure !== undefined
          || baseUrlFailure !== undefined}
        submitLabel={t('apply')}
        submitBusyLabel={t('applying')}
        cancelLabel={t('cancel')}
        onCancel={() => { props.onClose(false) }}
        onSubmit={() => { void apply() }}
      />
    </div>
  )
}
