/**
 * The model list of one provider, plus the action that asks the provider what
 * it serves. Ported from dsh's `ui-settings-models` ModelListEditor, restyled
 * after the reference's model rows: one line per model — id, capability
 * badges derived from the profile, an enable switch, and edit/delete — with
 * the full editor living in {@link ModelEditModal}.
 *
 * The list is the provider's `models` array as the card holds it, replaced as
 * one array on save. Fetching asks the endpoint **the form currently shows** —
 * including a key typed but not yet saved — so adding a provider is one pass
 * instead of save-then-return; the reply is candidates the user picks from,
 * never configuration written behind them. A provider that cannot be
 * interrogated (an unreachable endpoint) is not a dead end: the failure is
 * shown next to the rows the user can still fill in by hand.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import {
  Button,
  IconCopyOutline16,
  IconEditOutline16,
  IconPlusOutline16,
  Modal,
  writeClipboard,
} from '../../ui/primitives/index.ts'
import { badgeCapacity } from './capacity.ts'
import type { ModelDraft } from './capacity.ts'
import { discoverModels } from './discover.ts'
import type { DiscoverTarget } from './discover.ts'
import { ModelEditModal } from './ModelEditModal.tsx'
import { t } from './copy.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link ModelListEditor}. */
export interface ModelListEditorProps {
  /** The rows as currently drafted. */
  models: readonly ModelDraft[]
  /** Replace the drafted rows. */
  onChange: (models: ModelDraft[]) => void
  /** Endpoint facts for the fetch action. */
  probe: DiscoverTarget
  /**
   * Reason text naming why the fetch action is unavailable, or `undefined`
   * when it is. The card owns this because the key it would send is judged
   * there: asking with a key the form has already refused spends a round trip
   * to be told what the field already says.
   */
  probeBlocked?: string | undefined
  /** Disable every control (a pending write). */
  disabled: boolean
}

/** A row's text field, or the empty string when unset. */
function textOf(model: ModelDraft, key: 'id' | 'name'): string {
  const value = model[key]
  return typeof value === 'string' ? value : ''
}

/** A model's `piWebx.enabled` reads as enabled unless switched off. */
function isEnabled(model: ModelDraft): boolean {
  return model.piWebx?.enabled !== false
}

/**
 * The badges a row shows: the context window as quoted (`1M`), and the input
 * kinds beyond text — all derived from the profile, never stored separately.
 */
function badgesOf(model: ModelDraft): string[] {
  const badges: string[] = []
  if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
    badges.push(badgeCapacity(model.contextWindow))
  }
  if (Array.isArray(model.input) && model.input.includes('image')) badges.push(t('badgeVision'))
  const extension = model.piWebx?.inputFormat
  if (extension?.video === true) badges.push(t('badgeVideo'))
  if (extension?.audio === true) badges.push(t('badgeAudio'))
  if (extension?.pdf === true) badges.push(t('badgePdf'))
  return badges
}

/**
 * Render the model list with its fetch action.
 * @param props - the drafted rows, probe target, and gating.
 * @returns the model-list editor.
 */
export function ModelListEditor(props: ModelListEditorProps): ReactNode {
  const { models, onChange, probe, disabled } = props
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [candidates, setCandidates] = useState<readonly string[] | undefined>(undefined)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [candidateQuery, setCandidateQuery] = useState('')
  /** Index opened in the editor modal, or `'new'` while creating one. */
  const [editing, setEditing] = useState<number | 'new' | undefined>(undefined)

  /** Replace one row wholesale (the modal hands back a finished draft). */
  const replaceRow = (index: number, draft: ModelDraft): void => {
    onChange(models.map((model, at) => (at === index ? draft : model)))
  }

  const toggleEnabled = (index: number, enabled: boolean): void => {
    onChange(models.map((model, at) => {
      if (at !== index) return model
      const piWebx = { ...(model.piWebx ?? {}) }
      piWebx.enabled = enabled
      return { ...model, piWebx }
    }))
  }

  const fetchCandidates = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      let found: string[]
      try {
        found = await discoverModels(probe)
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error))
        return
      }
      if (found.length === 0) {
        setFailure(t('fetchEmpty'))
        return
      }
      // Everything already configured starts unchecked, so adopting a
      // selection never silently rewrites a capacity the user corrected.
      const known = new Set(models.map(model => textOf(model, 'id')))
      setCandidateQuery('')
      setCandidates(found)
      setPicked(new Set(found.filter(id => !known.has(id))))
    } finally {
      setBusy(false)
    }
  }

  const closePicker = (): void => {
    setCandidates(undefined)
    setPicked(new Set())
    setCandidateQuery('')
  }

  const adoptPicked = (): void => {
    /* v8 ignore next -- the dialog only renders with candidates loaded */
    if (candidates === undefined) return
    const byId = new Map(models.map(model => [textOf(model, 'id'), model]))
    for (const id of candidates) {
      if (!picked.has(id)) continue
      // A row the user already tuned wins over anything adoption would say.
      // Keyed by id, so a half-typed row whose id is still empty is not a
      // match and the candidate joins as its own row — correct, since a row
      // without an id is not yet a model and the create/apply gates refuse it.
      if (!byId.has(id)) byId.set(id, { id })
    }
    onChange([...byId.values()])
    closePicker()
  }

  const toggle = (id: string): void => {
    setPicked((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  const activeCandidates = candidates ?? []
  const normalizedCandidateQuery = candidateQuery.trim().toLowerCase()
  const visibleCandidates = normalizedCandidateQuery.length === 0
    ? activeCandidates
    : activeCandidates.filter(id => id.toLowerCase().includes(normalizedCandidateQuery))
  const allVisibleCandidatesPicked = visibleCandidates.length > 0
    && visibleCandidates.every(id => picked.has(id))

  const toggleVisibleCandidates = (): void => {
    setPicked((current) => {
      if (visibleCandidates.every(id => current.has(id))) {
        return new Set()
      }
      const next = new Set(current)
      for (const id of visibleCandidates) next.add(id)
      return next
    })
  }

  // An existing provider can answer through its stored endpoint; only a draft
  // with neither a route nor a baseUrl has nothing to ask about.
  const askable = probe.providerId !== undefined || (probe.baseUrl !== undefined && probe.baseUrl.length > 0)
  const editingDraft = typeof editing === 'number' ? models[editing] : undefined
  return (
    <section className={styles['modelCatalog']} aria-label={t('models')}>
      <div className={styles['modelListHead']}>
        <span className={styles['modelCatalogTitle']}>{t('models')}</span>
        <span className={styles['modelListActions']}>
          <button
            type="button"
            className={styles['linkButton']}
            disabled={disabled || busy || !askable || props.probeBlocked !== undefined}
            title={props.probeBlocked ?? (askable ? undefined : t('fetchNeedsBaseUrl'))}
            onClick={() => { void fetchCandidates() }}
          >
            {busy ? t('fetching') : t('fetchModels')}
          </button>
          <button
            type="button"
            className={styles['secondaryButton']}
            disabled={disabled}
            onClick={() => { setEditing('new') }}
          >
            <IconPlusOutline16 size={14} />
            {t('addModel')}
          </button>
        </span>
      </div>
      {models.length === 0 ? <p className={styles['modelEmpty']}>{t('modelsEmpty')}</p> : null}
      {models.length === 0
        ? null
        : (
          <ul className={styles['modelList']}>
            {models.map((model, index) => {
              const badges = badgesOf(model)
              const enabled = isEnabled(model)
              const id = textOf(model, 'id')
              return (
                <li key={`${id}-${String(index)}`} className={styles['modelRow']}>
                  <span className={styles['modelRowId']} title={id}>
                    {id || t('modelId')}
                  </span>
                  <span className={styles['modelBadges']}>
                    {badges.map(badge => (
                      <span key={badge} className={styles['badge']}>{badge}</span>
                    ))}
                  </span>
                  <span className={styles['modelRowActions']}>
                    <button
                      type="button"
                      className={styles['iconButton']}
                      aria-label={`${t('copyModelId')} ${index + 1}`}
                      title={t('copyModelId')}
                      disabled={disabled || id.length === 0}
                      onClick={() => { void writeClipboard(id) }}
                    >
                      <IconCopyOutline16 size={14} />
                    </button>
                    <button
                      type="button"
                      className={styles['iconButton']}
                      aria-label={`${t('editModel')} ${index + 1}`}
                      title={t('editModel')}
                      disabled={disabled}
                      onClick={() => { setEditing(index) }}
                    >
                      <IconEditOutline16 size={14} />
                    </button>
                    <label
                      className={styles['modelRowToggle']}
                      title={enabled ? t('modelEnabled') : t('modelDisabled')}
                    >
                      <input
                        type="checkbox"
                        role="switch"
                        checked={enabled}
                        aria-label={`${t('modelEnabled')} ${index + 1}`}
                        disabled={disabled}
                        onChange={(event) => { toggleEnabled(index, event.target.checked) }}
                      />
                    </label>
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}

      {editing === undefined
        ? null
        : (
          <ModelEditModal
            key={editing === 'new' ? 'new' : String(editing)}
            open
            model={editingDraft}
            takenIds={models.map(model => textOf(model, 'id')).filter(entry => entry.length > 0)}
            onClose={() => { setEditing(undefined) }}
            onSubmit={(draft) => {
              if (editing === 'new') onChange([...models, draft])
              else replaceRow(editing, draft)
              setEditing(undefined)
            }}
            onDelete={typeof editing === 'number'
              ? () => {
                onChange(models.filter((_model, at) => at !== editing))
                setEditing(undefined)
              }
              : undefined}
          />
        )}

      <Modal
        open={candidates !== undefined}
        onClose={closePicker}
        title={t('fetchTitle')}
        closeLabel={t('close')}
        description={t('fetchDescription')}
        className={styles['fetchDialog'] as string}
        footer={(
          <>
            <Button variant="outline" onClick={closePicker}>{t('cancel')}</Button>
            <Button variant="outline" onClick={adoptPicked}>{t('fetchAdopt')}</Button>
          </>
        )}
      >
        <div className={styles['candidateToolbar']}>
          <input
            className={`${styles['input']} ${styles['candidateSearch']}`}
            type="search"
            value={candidateQuery}
            placeholder={t('fetchSearch')}
            aria-label={t('fetchSearch')}
            onChange={(event) => { setCandidateQuery(event.target.value) }}
          />
          <Button
            variant="ghost"
            size="sm"
            disabled={visibleCandidates.length === 0}
            onClick={toggleVisibleCandidates}
          >
            {t(allVisibleCandidatesPicked ? 'fetchDeselectAll' : 'fetchSelectAll')}
          </Button>
        </div>
        {visibleCandidates.length === 0
          ? <p className={styles['candidateEmpty']} role="status">{t('fetchNoMatches')}</p>
          : (
            <ul className={styles['candidateList']}>
              {visibleCandidates.map(id => (
                <li key={id} className={styles['candidate']}>
                  <label className={styles['candidateLabel']}>
                    <input
                      type="checkbox"
                      checked={picked.has(id)}
                      onChange={() => { toggle(id) }}
                    />
                    {/* The id alone: it is the string adoption writes; the
                        capacities are edited in the row that appears. */}
                    <span className={styles['candidateId']}>{id}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
      </Modal>
    </section>
  )
}
