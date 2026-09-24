/**
 * The sub-agent editor's state machine, and its writes.
 *
 * The section's two views (list ⇄ form) are one editor: which definition is on
 * screen, the draft, the unsaved-edits guard, and the three writes. All three
 * writes go through the same compare-and-set — the list's enable switch is not a
 * shortcut, because a stale list overwriting a definition someone just edited is
 * exactly what the revision is there to prevent.
 *
 * The rules themselves stay in `agent-definitions-form.ts` (pure functions); this
 * hook only holds their state and the I/O, which is what lets the component stay
 * a render function and the gate drive the rules without a DOM.
 *
 * A lost compare-and-set (409) re-reads the list and keeps the draft: the user's
 * unsaved text is the one thing a conflict must not throw away.
 */

import { useCallback, useMemo, useState } from 'react'
import type { AgentDefinition, AgentDefinitionsResponse } from '../../shared/agent-definitions'
import { agentDefinitionsApi } from '../../lib/agentDefinitions'
import {
  agentFormValuesFromDefinition,
  createAgentFormValues,
  createInputFromValues,
  isAgentFormDirty,
  patchFromValues,
  reconcileConflict,
  validateAgentForm,
  type AgentFormProblems,
  type AgentFormValues,
} from './agent-definitions-form.ts'
import { messageOf, statusOf } from './use-agent-catalog.ts'

/** A one-line result message shown above the editor. */
export interface AgentNotice {
  text: string
  tone: 'info' | 'error' | 'success'
}

/** The write surface handed in by {@link useAgentCatalog}. */
export interface AgentFormTarget {
  /** File revision the caller last read; every write is compare-and-set on it. */
  revision: number | undefined
  /**
   * The user's own definitions, and only those: a definition of the same name
   * shadows a built-in on purpose, so a built-in is not a duplicate-name sibling.
   */
  userAgents: readonly AgentDefinition[]
  /** Swap in a write's answer: every write returns the fresh list. */
  setListed: (response: AgentDefinitionsResponse) => void
  /** Re-read the list after a lost compare-and-set, for the conflict notice. */
  loadDefinitions: () => Promise<AgentDefinitionsResponse | undefined>
}

/** Everything the section's two views need from the editor. */
export interface AgentForm {
  /** The definition being edited; `undefined` with `creating` false means the list. */
  editing: AgentDefinition | undefined
  creating: boolean
  /** True while a definition is on screen (new or existing), not the list. */
  showForm: boolean
  draft: AgentFormValues
  /** What the draft would mean to the server: blocking errors and warnings. */
  problems: AgentFormProblems
  busy: boolean
  notice: AgentNotice | undefined
  formError: string | undefined
  /** A queued action to run after the user agrees to drop unsaved edits. */
  confirmDiscard: (() => void) | undefined
  /** The definition a delete is being confirmed for. */
  confirmDelete: AgentDefinition | undefined
  update: (patch: Partial<AgentFormValues>) => void
  /** Run `next` now, or after the user agrees to drop unsaved edits. */
  guardDirty: (next: () => void) => void
  openNew: () => void
  openExisting: (agent: AgentDefinition) => void
  /** Back to the list without guarding: use {@link backToList} for the button. */
  closeForm: () => void
  /** Back to the list, guarding unsaved edits. */
  backToList: () => void
  save: () => Promise<void>
  toggleEnabled: (agent: AgentDefinition, enabled: boolean) => Promise<void>
  doDelete: () => Promise<void>
  setNotice: (notice: AgentNotice | undefined) => void
  setConfirmDiscard: (next: (() => void) | undefined) => void
  setConfirmDelete: (agent: AgentDefinition | undefined) => void
}

/**
 * Own the editor: draft, unsaved-edits guard, dialogs and the three writes.
 * @param target - the revision, sibling list and list setters from the catalog.
 * @returns the editor state and every action the section renders.
 */
export function useAgentForm({ revision, userAgents, setListed, loadDefinitions }: AgentFormTarget): AgentForm {
  /** The definition being edited; `undefined` with `creating` false means the list. */
  const [editing, setEditing] = useState<AgentDefinition | undefined>(undefined)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<AgentFormValues>(createAgentFormValues)

  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<AgentNotice | undefined>(undefined)
  const [formError, setFormError] = useState<string | undefined>(undefined)
  const [confirmDiscard, setConfirmDiscard] = useState<(() => void) | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState<AgentDefinition | undefined>(undefined)

  const dirty = isAgentFormDirty(draft, editing)
  const showForm = creating || editing !== undefined

  const problems = useMemo(
    () => validateAgentForm(draft, userAgents, editing),
    [draft, userAgents, editing],
  )

  const update = (patch: Partial<AgentFormValues>): void => {
    setDraft((current) => ({ ...current, ...patch }))
  }

  const guardDirty = useCallback(
    (next: () => void): void => {
      if (!dirty) {
        next()
        return
      }
      setConfirmDiscard(() => () => {
        setConfirmDiscard(undefined)
        next()
      })
    },
    [dirty],
  )

  const openNew = useCallback((): void => {
    setEditing(undefined)
    setCreating(true)
    setDraft(createAgentFormValues())
    setFormError(undefined)
    setNotice(undefined)
  }, [])

  const openExisting = useCallback((agent: AgentDefinition): void => {
    setEditing(agent)
    setCreating(false)
    setDraft(agentFormValuesFromDefinition(agent))
    setFormError(undefined)
    setNotice(undefined)
  }, [])

  const closeForm = useCallback((): void => {
    setEditing(undefined)
    setCreating(false)
    setDraft(createAgentFormValues())
    setFormError(undefined)
  }, [])

  const backToList = useCallback((): void => {
    guardDirty(closeForm)
  }, [closeForm, guardDirty])

  /**
   * A write lost the compare-and-set. The fresh list replaces the version; the
   * draft is left on screen, because the user's unsaved text is the one thing a
   * conflict must not throw away.
   */
  const onConflict = useCallback(async (): Promise<void> => {
    const fresh = await loadDefinitions()
    if (fresh === undefined) return
    const reconciled = reconcileConflict(draft, fresh)
    setNotice({ text: reconciled.notice, tone: 'error' })
  }, [draft, loadDefinitions])

  const save = useCallback(async (): Promise<void> => {
    if (revision === undefined) return
    if (problems.errors.length > 0) {
      setFormError(problems.errors.join(' '))
      return
    }
    setBusy(true)
    setFormError(undefined)
    try {
      if (editing === undefined) {
        const answer = await agentDefinitionsApi.create(revision, createInputFromValues(draft))
        setListed(answer)
        closeForm()
        setNotice({ text: '已新增子智能体。', tone: 'success' })
      } else {
        const patch = patchFromValues(draft, editing)
        const answer = await agentDefinitionsApi.update(editing.id, revision, patch)
        setListed(answer)
        closeForm()
        setNotice({ text: '已保存。', tone: 'success' })
      }
    } catch (error) {
      if (statusOf(error) === 409) await onConflict()
      else setFormError(messageOf(error))
    } finally {
      setBusy(false)
    }
  }, [closeForm, draft, editing, onConflict, problems.errors, revision, setListed])

  /**
   * The list's enable switch writes through the same CAS as a form save — there
   * is no separate endpoint, and a shortcut here is how a stale list overwrites a
   * definition someone just edited.
   */
  const toggleEnabled = useCallback(
    async (agent: AgentDefinition, enabled: boolean): Promise<void> => {
      if (revision === undefined) return
      setBusy(true)
      setNotice(undefined)
      try {
        const answer = await agentDefinitionsApi.update(agent.id, revision, { enabled })
        const fresh = answer.agents.find((candidate) => candidate.id === agent.id)
        setListed(answer)
        if (editing?.id === agent.id && fresh !== undefined) setEditing(fresh)
        setNotice({
          text: enabled
            ? '已启用：下次调度可自动调用，当前正在运行的任务不受影响。'
            : '已停用：下次调度不再自动调用，当前正在运行的任务不会被中断。',
          tone: 'success',
        })
      } catch (error) {
        if (statusOf(error) === 409) await onConflict()
        else setNotice({ text: messageOf(error), tone: 'error' })
      } finally {
        setBusy(false)
      }
    },
    [editing?.id, onConflict, revision, setListed],
  )

  const doDelete = useCallback(async (): Promise<void> => {
    const target = confirmDelete
    if (target === undefined || revision === undefined) return
    setConfirmDelete(undefined)
    setBusy(true)
    try {
      const answer = await agentDefinitionsApi.delete(target.id, revision)
      // A draft that was never saved is kept: deleting a sibling is no reason to
      // discard text the user is still writing.
      setListed(answer)
      if (editing?.id === target.id) closeForm()
      setNotice({ text: '已删除。', tone: 'success' })
    } catch (error) {
      if (statusOf(error) === 404) {
        await loadDefinitions()
        setNotice({ text: '该子智能体已不存在，列表已刷新。', tone: 'error' })
      } else if (statusOf(error) === 409) {
        await onConflict()
      } else {
        setNotice({ text: messageOf(error), tone: 'error' })
      }
    } finally {
      setBusy(false)
    }
  }, [closeForm, confirmDelete, editing?.id, loadDefinitions, onConflict, revision, setListed])

  return {
    editing,
    creating,
    showForm,
    draft,
    problems,
    busy,
    notice,
    formError,
    confirmDiscard,
    confirmDelete,
    update,
    guardDirty,
    openNew,
    openExisting,
    closeForm,
    backToList,
    save,
    toggleEnabled,
    doDelete,
    setNotice,
    setConfirmDiscard,
    setConfirmDelete,
  }
}
