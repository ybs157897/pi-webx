/**
 * The model editor modal — the reference's `编辑模型配置`, wired to pi's own
 * model schema.
 *
 * What pi can honour is written to its native keys (`contextWindow`,
 * `maxTokens`, `input`, `reasoning` + `thinkingLevelMap`); everything pi has no
 * concept for yet (video/audio/pdf input kinds, capability flags, the JSONata
 * reasoning map) is kept in the entry's `piWebx` namespace and labelled as
 * recorded-only, so nothing here reads as working when pi would ignore it.
 *
 * `智能配置` is real: it asks the bridge what pi's bundled catalogue knows for
 * the id (context window, output limit, input kinds, whether it reasons) and
 * fills the fields that are still empty — the pi-webx equivalent of the
 * reference matching a model against its built-in rules.
 */

import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconQuestionOutline14, Modal, Tooltip } from '../../ui/primitives/index.ts'
import type { ModelExtension } from '../../shared/models-config'
import { PI_THINKING_LEVELS, type PiThinkingLevel } from '../../shared/protocol'
import { errorMessage, modelsConfigApi } from '../../lib/modelsConfig'
import { formatCapacity, parseCapacity } from './capacity.ts'
import type { ModelDraft } from './capacity.ts'
import { t } from './copy.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link ModelEditModal}. */
export interface ModelEditModalProps {
  open: boolean
  /** The row being edited; absent while creating a new one. */
  model?: ModelDraft | undefined
  /** Ids the provider's other rows already use. */
  takenIds?: readonly string[]
  onClose: () => void
  /** Called with the finished draft; the caller owns the write. */
  onSubmit: (draft: ModelDraft) => void
  /**
   * Drop this model from the provider. Absent while creating one, and owned by
   * the caller like {@link onSubmit}: the list is the caller's draft.
   */
  onDelete?: (() => void) | undefined
}

/** Chinese labels for the thinking-level chips, in pi's low→high order. */
const LEVEL_LABELS: Record<PiThinkingLevel, string> = {
  off: '关闭',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
}

/** The extension input kinds the modal edits (text/image ride pi's `input`). */
type ExtensionInput = 'audio' | 'video' | 'pdf'

/** Capability flags the modal edits; `toolCall` is preserved but not shown. */
type CapabilityKey = 'jsonSchemaOutput' | 'nativeWebSearch' | 'midConversationSystem'

const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  jsonSchemaOutput: '结构化输出',
  nativeWebSearch: '原生联网搜索',
  midConversationSystem: '对话中系统消息',
}

/** Capacity text for a stored count, '' when unset. */
function capacityText(value: number | undefined): string {
  return value === undefined ? '' : formatCapacity(value)
}

/**
 * A field caption with the reference's `?` help affordance.
 *
 * The reference keeps every explanation behind this glyph rather than as
 * permanent small print, which is what lets a form of this length read as a
 * form. The text is the same either way — only its resting place moves — so the
 * pi-specific caveats (which fields pi does not consume yet) stay reachable
 * without pushing every control down the modal.
 */
function FieldLabel({ text, hint }: { text: string; hint?: string | undefined }): ReactNode {
  if (hint === undefined) return <span className={styles['modalFieldLabel']}>{text}</span>
  return (
    <span className={styles['modalFieldLabel']}>
      {text}
      <Tooltip label={hint} side="right" maxWidth={320}>
        <span className={styles['fieldHelp']} role="img" aria-label={hint} tabIndex={0}>
          <IconQuestionOutline14 size={14} />
        </span>
      </Tooltip>
    </span>
  )
}

/**
 * Render the model editor.
 * @param props - the draft, the duplicate-id set, and the save/cancel contract.
 * @returns the modal.
 */
export function ModelEditModal(props: ModelEditModalProps): ReactNode {
  const existing = props.model
  const ext: ModelExtension = existing?.piWebx ?? {}

  const [smart, setSmart] = useState(false)
  const [smartNote, setSmartNote] = useState<string | undefined>(undefined)
  const [id, setId] = useState(existing?.id ?? '')
  const [name, setName] = useState(existing?.name ?? '')
  const [context, setContext] = useState(capacityText(existing?.contextWindow))
  const [maxTokens, setMaxTokens] = useState(capacityText(existing?.maxTokens))
  const [images, setImages] = useState(
    Array.isArray(existing?.input) && existing.input.includes('image'),
  )
  const [extensionInputs, setExtensionInputs] = useState<Record<ExtensionInput, boolean>>({
    audio: ext.inputFormat?.audio === true,
    video: ext.inputFormat?.video === true,
    pdf: ext.inputFormat?.pdf === true,
  })
  const [capabilities, setCapabilities] = useState<Record<CapabilityKey, boolean>>({
    jsonSchemaOutput: ext.capabilities?.jsonSchemaOutput === true,
    nativeWebSearch: ext.capabilities?.nativeWebSearch === true,
    midConversationSystem: ext.capabilities?.midConversationSystem === true,
  })
  const [levels, setLevels] = useState<PiThinkingLevel[]>(
    // Existing map keys, in the vocabulary's own order.
    PI_THINKING_LEVELS.filter((level) => existing?.thinkingLevelMap?.[level] !== undefined),
  )
  const [mapText, setMapText] = useState(ext.reasoningLevelMap ?? '')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [probing, setProbing] = useState(false)

  /**
   * Fill from pi's catalogue: only fields still empty, so a typed value is
   * never overwritten by a suggestion.
   */
  const runSmartFill = useCallback(async (modelId: string): Promise<void> => {
    if (modelId.trim().length === 0) return
    setProbing(true)
    setSmartNote(undefined)
    try {
      const { match } = await modelsConfigApi.suggest(modelId.trim())
      if (match === null) {
        setSmartNote(t('smartNoMatch'))
        return
      }
      const filled: string[] = []
      if (context.trim().length === 0 && match.contextWindow !== undefined) {
        setContext(formatCapacity(match.contextWindow))
        filled.push('上下文窗口')
      }
      if (maxTokens.trim().length === 0 && match.maxTokens !== undefined) {
        setMaxTokens(formatCapacity(match.maxTokens))
        filled.push('最大输出')
      }
      if (match.input?.includes('image')) {
        setImages(true)
        filled.push('图片输入')
      }
      if (match.reasoning === true && levels.length === 0) {
        setLevels([...PI_THINKING_LEVELS])
        filled.push('推理等级')
      }
      setSmartNote(
        filled.length === 0
          ? t('smartNothingToFill')
          : `已从 pi 内置目录补全：${filled.join('、')}（来源 ${match.provider}）`,
      )
    } catch (error) {
      setSmartNote(errorMessage(error))
    } finally {
      setProbing(false)
    }
  }, [context, levels.length, maxTokens])

  const toggleSmart = (checked: boolean): void => {
    setSmart(checked)
    if (checked) void runSmartFill(id)
    else setSmartNote(undefined)
  }

  const remainingLevels = PI_THINKING_LEVELS.filter((level) => !levels.includes(level))

  const contextValue = parseCapacity(context)
  const maxValue = parseCapacity(maxTokens)
  const duplicate = props.takenIds?.includes(id.trim()) === true && id.trim() !== existing?.id
  const idFailure = id.trim().length === 0
    ? t('modelIdRequired')
    : duplicate
      ? t('modelIdDuplicate')
      : undefined
  const capacityFailure = Number.isNaN(contextValue) || Number.isNaN(maxValue)
    ? '容量必须是数字，可带 K/M 后缀（如 256K、1M）'
    : undefined

  const buildExtension = (): ModelExtension | undefined => {
    const next: ModelExtension = { ...ext }
    delete next.inputFormat
    delete next.capabilities
    delete next.reasoningLevelMap
    const inputFormat: NonNullable<ModelExtension['inputFormat']> = {}
    for (const kind of ['audio', 'video', 'pdf'] as const) {
      if (extensionInputs[kind]) inputFormat[kind] = true
    }
    if (Object.keys(inputFormat).length > 0) next.inputFormat = inputFormat
    const capabilityFlags: NonNullable<ModelExtension['capabilities']> = { ...ext.capabilities }
    for (const key of Object.keys(CAPABILITY_LABELS) as CapabilityKey[]) {
      if (capabilities[key]) capabilityFlags[key] = true
      else delete capabilityFlags[key]
    }
    if (Object.keys(capabilityFlags).length > 0) next.capabilities = capabilityFlags
    if (mapText.trim().length > 0) next.reasoningLevelMap = mapText.trim()
    return Object.keys(next).length === 0 ? undefined : next
  }

  const submit = (): void => {
    if (idFailure !== undefined || capacityFailure !== undefined) {
      setFailure(idFailure ?? capacityFailure)
      return
    }
    const draft: ModelDraft = {
      id: id.trim(),
      ...(name.trim().length > 0 ? { name: name.trim() } : {}),
      ...(contextValue !== undefined ? { contextWindow: contextValue } : {}),
      ...(maxValue !== undefined ? { maxTokens: maxValue } : {}),
      input: images ? ['text', 'image'] : ['text'],
      ...(levels.length > 0
        ? {
            reasoning: true,
            thinkingLevelMap: Object.fromEntries(levels.map((level) => [level, level])),
          }
        : {}),
    }
    const extension = buildExtension()
    if (extension !== undefined) draft.piWebx = extension
    props.onSubmit(draft)
  }

  const reset = (): void => {
    setId(existing?.id ?? '')
    setName(existing?.name ?? '')
    setContext(capacityText(existing?.contextWindow))
    setMaxTokens(capacityText(existing?.maxTokens))
    setImages(Array.isArray(existing?.input) && existing.input.includes('image'))
    setExtensionInputs({
      audio: ext.inputFormat?.audio === true,
      video: ext.inputFormat?.video === true,
      pdf: ext.inputFormat?.pdf === true,
    })
    setCapabilities({
      jsonSchemaOutput: ext.capabilities?.jsonSchemaOutput === true,
      nativeWebSearch: ext.capabilities?.nativeWebSearch === true,
      midConversationSystem: ext.capabilities?.midConversationSystem === true,
    })
    setLevels(PI_THINKING_LEVELS.filter((level) => existing?.thinkingLevelMap?.[level] !== undefined))
    setMapText(ext.reasoningLevelMap ?? '')
    setSmart(false)
    setSmartNote(undefined)
    setFailure(undefined)
  }

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={existing === undefined ? t('modelModalCreate') : t('modelModalTitle')}
      closeLabel={t('close')}
      className={styles['modelModal'] as string}
      contentClassName={styles['modelModalBody'] as string}
      footer={(
        <>
          {props.onDelete === undefined
            ? null
            : (
              <button type="button" className={styles['dangerButton']} onClick={props.onDelete}>
                {t('removeModel')}
              </button>
            )}
          <span className={styles['footerSpacer']} />
          <Button variant="outline" onClick={props.onClose}>{t('cancel')}</Button>
          <Button variant="outline" onClick={submit}>{t('save')}</Button>
        </>
      )}
    >
      <label className={styles['modalSwitchRow']}>
        <span className={styles['modalSwitchLabel']}>
          {t('smartConfig')}
          <Tooltip label={t('smartConfigHint')} side="right" maxWidth={320}>
            <span className={styles['fieldHelp']} role="img" aria-label={t('smartConfigHint')} tabIndex={0}>
              <IconQuestionOutline14 size={14} />
            </span>
          </Tooltip>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={smart}
          disabled={probing}
          aria-label={t('smartConfig')}
          onChange={(event) => { toggleSmart(event.target.checked) }}
        />
      </label>
      {smartNote === undefined ? null : <p className={styles['modalHint']}>{smartNote}</p>}

      <label className={styles['modalField']}>
        <span className={styles['modalFieldLabel']}>{t('modelId')}</span>
        <input
          className={styles['input']}
          type="text"
          value={id}
          placeholder="provider/model-id"
          disabled={probing}
          onChange={(event) => { setId(event.target.value) }}
          onBlur={() => { if (smart) void runSmartFill(id) }}
        />
      </label>

      <label className={styles['modalField']}>
        <span className={styles['modalFieldLabel']}>{t('modelContextWindow')}</span>
        <input
          className={styles['input']}
          type="text"
          inputMode="numeric"
          value={context}
          placeholder="256K / 1M"
          onChange={(event) => { setContext(event.target.value) }}
        />
      </label>

      <label className={styles['modalField']}>
        <span className={styles['modalFieldLabel']}>{t('modelMaxTokens')}</span>
        <input
          className={styles['input']}
          type="text"
          inputMode="numeric"
          value={maxTokens}
          placeholder="32K / 384K"
          onChange={(event) => { setMaxTokens(event.target.value) }}
        />
      </label>

      <details className={styles['modalAdvanced']} open>
        <summary className={styles['modalAdvancedSummary']}>{t('advancedConfig')}</summary>

        <label className={styles['modalField']}>
          <span className={styles['modalFieldLabel']}>{t('modelName')}</span>
          <input
            className={styles['input']}
            type="text"
            value={name}
            placeholder={t('modelNameOptional')}
            onChange={(event) => { setName(event.target.value) }}
          />
        </label>

        <div className={styles['modalField']}>
          <FieldLabel text={t('inputTypes')} hint={t('extensionInputHint')} />
          <div className={styles['chipRow']}>
            <span className={`${styles['chip']} ${styles['chipLocked']}`} title={t('textAlwaysOn')}>
              {t('textInput')}（必选）
            </span>
            <label className={`${styles['chip']} ${images ? styles['chipOn'] : ''}`}>
              <input
                type="checkbox"
                checked={images}
                onChange={(event) => { setImages(event.target.checked) }}
              />
              {t('imageInput')}
            </label>
            {(['video', 'audio', 'pdf'] as ExtensionInput[]).map((kind) => (
              <label
                key={kind}
                className={`${styles['chip']} ${extensionInputs[kind] ? styles['chipOn'] : ''}`}
              >
                <input
                  type="checkbox"
                  checked={extensionInputs[kind]}
                  onChange={(event) => {
                    setExtensionInputs((current) => ({ ...current, [kind]: event.target.checked }))
                  }}
                />
                {kind === 'video' ? t('videoInput') : kind === 'audio' ? t('audioInput') : t('pdfInput')}
              </label>
            ))}
          </div>
        </div>

        <div className={styles['modalField']}>
          <FieldLabel text={t('modelCapabilities')} hint={t('capabilityHint')} />
          <div className={styles['chipRow']}>
            {(Object.keys(CAPABILITY_LABELS) as CapabilityKey[]).map((key) => (
              <label key={key} className={`${styles['chip']} ${capabilities[key] ? styles['chipOn'] : ''}`}>
                <input
                  type="checkbox"
                  checked={capabilities[key]}
                  onChange={(event) => {
                    setCapabilities((current) => ({ ...current, [key]: event.target.checked }))
                  }}
                />
                {CAPABILITY_LABELS[key]}
              </label>
            ))}
          </div>
        </div>

        <div className={styles['modalField']}>
          <FieldLabel text={t('reasoningLevels')} hint={t('reasoningLevelsHint')} />
          <div className={styles['chipRow']}>
            {levels.map((level) => (
              <button
                key={level}
                type="button"
                className={`${styles['chip']} ${styles['chipOn']} ${styles['chipButton']}`}
                title={t('removeLevel')}
                onClick={() => { setLevels((current) => current.filter((entry) => entry !== level)) }}
              >
                {LEVEL_LABELS[level]} ✕
              </button>
            ))}
            {remainingLevels.length > 0 ? (
              <select
                className={`${styles['chip']} ${styles['chipAdd']}`}
                value=""
                aria-label={t('addLevel')}
                onChange={(event) => {
                  const level = event.target.value as PiThinkingLevel
                  if (level.length > 0) setLevels((current) => [...current, level])
                }}
              >
                <option value="">＋</option>
                {remainingLevels.map((level) => (
                  <option key={level} value={level}>{LEVEL_LABELS[level]}</option>
                ))}
              </select>
            ) : null}
          </div>
        </div>

        <div className={styles['modalField']}>
          <FieldLabel text={t('reasoningMap')} hint={t('reasoningMapHint')} />
          <textarea
            className={styles['modalCode']}
            rows={4}
            value={mapText}
            spellCheck={false}
            placeholder={'reasoningLevel == "off" ? { enabled: false } : {}'}
            onChange={(event) => { setMapText(event.target.value) }}
          />
        </div>
      </details>

      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      <div className={styles['modalFootnote']}>
        <button type="button" className={styles['linkButton']} onClick={reset}>
          {t('resetForm')}
        </button>
      </div>
    </Modal>
  )
}
