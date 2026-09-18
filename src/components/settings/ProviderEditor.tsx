/**
 * One provider's editor pane, ported from dsh's `ui-settings-models`
 * ProviderEditor (pi-ai family) and laid out as the reference's detail column:
 * every field is on the pane at once — route, protocol, key — with the model
 * list last, rather than folded behind a disclosure. The whole form is the
 * desired state: a field sent as '' clears it, and the model list is written as
 * one array.
 *
 * The key field is write-only: a blank key keeps whatever is configured, which
 * is what makes saving a redacted view safe, and the eye reveals what is typed
 * without ever reading the stored secret back. The display name is edited on
 * the title itself (the reference renames through its header, not a field).
 *
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
import { IconEyeOffOutline16, IconEyeOutline16 } from '../../ui/primitives/index.ts'
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
  /** Ask the owner to open its delete confirmation for this provider. */
  onRequestDelete?: (() => void) | undefined
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
  const [enabled, setEnabled] = useState(provider.piWebx?.enabled !== false)
  const [keyDraft, setKeyDraft] = useState('')
  const [keyVisible, setKeyVisible] = useState(false)
  const [renaming, setRenaming] = useState(false)
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
        piWebx: { enabled },
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
            {renaming
              ? (
                <input
                  className={`${styles['input']} ${styles['editorTitleInput']}`}
                  type="text"
                  autoFocus
                  value={nameDraft}
                  placeholder={provider.id}
                  aria-label={t('customDisplayName')}
                  disabled={disabled}
                  onChange={(event) => { setNameDraft(event.target.value) }}
                  onBlur={() => { setRenaming(false) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === 'Escape') setRenaming(false)
                  }}
                />
              )
              : (
                <button
                  type="button"
                  className={styles['editorTitle']}
                  title={t('renameProvider')}
                  disabled={disabled}
                  onClick={() => { setRenaming(true) }}
                >
                  {nameDraft.trim().length > 0 ? nameDraft : provider.id}
                </button>
              )}
            {provider.name !== undefined && provider.name !== provider.id
              ? <span className={styles['editorRoute']}>{provider.id}</span>
              : null}
            <span className={styles['editorHeaderActions']}>
              <label
                className={styles['headerToggle']}
                title={enabled ? t('providerEnabled') : t('modelDisabled')}
              >
                <input
                  type="checkbox"
                  role="switch"
                  checked={enabled}
                  aria-label={t('providerEnabled')}
                  disabled={disabled}
                  onChange={(event) => { setEnabled(event.target.checked) }}
                />
              </label>
              {props.onRequestDelete === undefined
                ? null
                : (
                  <button
                    type="button"
                    className={styles['linkButton']}
                    disabled={disabled}
                    onClick={props.onRequestDelete}
                  >
                    {t('remove')}
                  </button>
                )}
            </span>
          </div>
        )}
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
          {/* A profile naming no protocol — hand-written into models.json with
              no model to need one — selects nothing rather than reading as if
              it had picked the first choice. Clearing back to it is offered
              only when nothing was stored. */}
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
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('keyInput')}</span>
        <div className={styles['secretField']}>
          <input
            className={`${styles['input']} ${styles['secretInput']}`}
            type={keyVisible ? 'text' : 'password'}
            autoComplete="off"
            value={keyDraft}
            placeholder={keyPlaceholder}
            aria-label={t('keyInput')}
            aria-invalid={keyFailure !== undefined}
            disabled={disabled}
            onChange={(event) => { setKeyDraft(event.target.value) }}
          />
          <button
            type="button"
            className={styles['secretToggle']}
            aria-label={t(keyVisible ? 'hideKey' : 'showKey')}
            title={t(keyVisible ? 'hideKey' : 'showKey')}
            aria-pressed={keyVisible}
            disabled={disabled}
            onClick={() => { setKeyVisible(current => !current) }}
          >
            {keyVisible ? <IconEyeOffOutline16 size={16} /> : <IconEyeOutline16 size={16} />}
          </button>
        </div>
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
